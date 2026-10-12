import { describe, expect, it } from 'vitest'
import type { InvocationDetail } from '@/api/generated/compute/InvocationDetail'
import { invocation } from './fixtures.test-support'
import {
  bodyHeader,
  composedRequest,
  draftFromInvocation,
  emptyInvokeDraft,
  invokeProblem,
  invokeRequest,
  pathWithQuery,
  splitPath,
} from './invoke-request'
import type { InvokeDraft } from './run-drafts'

const draft = (patch: Partial<InvokeDraft> = {}): InvokeDraft => ({
  ...emptyInvokeDraft(),
  ...patch,
})
const row = (key: string, value: string, enabled = true) => ({ id: key, key, value, enabled })

describe('the Invoke draft on the wire', () => {
  it('keeps the path and its query as one URL, two views', () => {
    const split = splitPath('/users?active=true&x=1')
    expect(split.path).toBe('/users')
    expect(split.query.map((pair) => [pair.key, pair.value])).toEqual([
      ['active', 'true'],
      ['x', '1'],
    ])
    expect(splitPath('').path).toBe('/')
    expect(splitPath('hello').path).toBe('/hello')
    expect(pathWithQuery(draft({ path: '/u', query: [row('a', '1'), row('b', '2', false)] }))).toBe(
      '/u?a=1',
    )
  })

  it('sends the body the method carries, its content type unless a header names one', () => {
    const json = draft({ method: 'POST', body: { kind: 'json', text: '{"n":1}' } })
    expect(bodyHeader(json)).toBe('application/json')
    expect(bodyHeader({ ...json, headers: [row('Content-Type', 'text/x')] })).toBeUndefined()
    expect(bodyHeader(draft({ method: 'GET', body: { kind: 'json', text: '{}' } }))).toBeUndefined()
    const request = invokeRequest(json, [
      { name: 'authorization', value: 'Bearer t', setBy: 'Call as' },
    ])
    expect(request).toEqual({
      target: 'url',
      method: 'POST',
      path: '/',
      headers: [
        { name: 'authorization', value: 'Bearer t' },
        { name: 'content-type', value: 'application/json' },
      ],
      body: '{"n":1}',
      encoding: 'text',
    })
    expect(
      invokeRequest(draft({ method: 'GET', body: { kind: 'json', text: '{}' } }), []).encoding,
    ).toBe('empty')
    expect(
      invokeRequest(draft({ method: 'PUT', body: { kind: 'base64', text: 'AA E=' } }), []).body,
    ).toBe('AAE=')
  })

  it("lets a header the person typed win over Call as's", () => {
    const request = invokeRequest(draft({ headers: [row('Authorization', 'Bearer mine')] }), [
      { name: 'authorization', value: 'Bearer minted', setBy: 'Call as' },
    ])
    expect(request.headers).toEqual([{ name: 'Authorization', value: 'Bearer mine' }])
  })

  it('says what keeps it from sending', () => {
    expect(invokeProblem(draft({ path: 'nope' }))).toMatch(/starts with/)
    expect(invokeProblem(draft({ method: 'POST', body: { kind: 'json', text: '{' } }))).toMatch(
      /does not parse/,
    )
    expect(invokeProblem(draft({ method: 'POST', body: { kind: 'base64', text: '***' } }))).toMatch(
      /not base64/,
    )
    expect(invokeProblem(draft())).toBeUndefined()
  })

  it('writes Call as into the code, so No auth adds no Authorization', () => {
    const composed = composedRequest(
      draft({ path: '/hello' }),
      'http://127.0.0.1:5001/p/us-central1/api',
      [],
    )
    expect(composed.codeUrl).toBe('http://127.0.0.1:5001/p/us-central1/api/hello')
    expect(composed.identity).toEqual({ kind: 'anonymous' })
    const signed = composedRequest(draft(), 'http://h/p/r/api', [
      { name: 'authorization', value: 'Bearer t', setBy: 'Call as' },
    ])
    expect(signed.headers).toEqual([{ key: 'authorization', value: 'Bearer t', enabled: true }])
  })

  it('fills a draft from a recorded request, leaving out what Call as mints and what the engine adds', () => {
    const detail = {
      summary: invocation(7),
      request: {
        target: 'url',
        method: 'post',
        path: '/orders?x=1',
        headers: [
          { name: 'authorization', value: null, sensitive: true },
          { name: 'x-demo', value: '2', sensitive: false },
          { name: 'x-firenook-console', value: '1', sensitive: false },
          { name: 'content-type', value: 'application/json', sensitive: false },
        ],
        contentType: 'application/json',
        body: { size: 7, truncated: false, encoding: 'text', text: '{"n":1}' },
      },
    } as unknown as InvocationDetail
    const filled = draftFromInvocation(detail, emptyInvokeDraft())
    expect(filled.method).toBe('POST')
    expect(filled.path).toBe('/orders')
    expect(filled.query.map((pair) => [pair.key, pair.value])).toEqual([['x', '1']])
    expect(filled.headers.map((pair) => pair.key)).toEqual(['x-demo'])
    expect(filled.body).toEqual({ kind: 'json', text: '{"n":1}' })
  })
})
