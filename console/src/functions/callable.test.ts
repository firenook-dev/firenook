import { describe, expect, it } from 'vitest'
import {
  appCheckClaims,
  appCheckToken,
  callableBody,
  projectNumberOf,
  readCallableResponse,
  readStream,
} from './callable'

function payloadOf(token: string): unknown {
  const body = token.split('.')[1] ?? ''
  return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')))
}

describe('the callable protocol', () => {
  it('wraps the data as the SDK does', () => {
    expect(callableBody('{"text":"hi"}')).toBe('{"data":{"text":"hi"}}')
    expect(callableBody('')).toBe('{"data":null}')
    expect(() => callableBody('{')).toThrow()
  })

  it('mints an App Check token with the claims the SDK reads', () => {
    expect(projectNumberOf('1:123456:web:abc')).toBe('123456')
    expect(projectNumberOf('nope')).toBeUndefined()
    expect(appCheckClaims('1:123:web:abc', 'demo-x', 1000)).toEqual({
      iss: 'https://firebaseappcheck.googleapis.com/123',
      aud: ['projects/123', 'projects/demo-x'],
      sub: '1:123:web:abc',
      iat: 1000,
      exp: 4600,
    })
    const token = appCheckToken('1:123:web:abc', 'demo-x', 1000)
    expect(token.endsWith('.')).toBe(true)
    expect(payloadOf(token)).toMatchObject({ sub: '1:123:web:abc' })
  })

  it('reads a result, an error, a stream and anything else', () => {
    expect(readCallableResponse(200, 'application/json', '{"result":{"ok":true}}')).toEqual({
      kind: 'result',
      result: { ok: true },
    })
    expect(
      readCallableResponse(
        400,
        'application/json',
        '{"error":{"status":"INVALID_ARGUMENT","message":"text is required","details":{"f":1}}}',
      ),
    ).toEqual({
      kind: 'error',
      status: 'INVALID_ARGUMENT',
      message: 'text is required',
      details: { f: 1 },
    })
    expect(readCallableResponse(500, 'text/html', '<h1>no</h1>')).toEqual({
      kind: 'other',
      status: 500,
      text: '<h1>no</h1>',
    })
    const stream = 'data: {"message":{"n":1}}\n\ndata: {"message":"two"}\n\ndata: {"result":3}\n\n'
    expect(readCallableResponse(200, 'text/event-stream', stream)).toEqual({
      kind: 'stream',
      chunks: [{ n: 1 }, 'two'],
      result: 3,
      done: true,
    })
  })

  it('reads a stream so far, a partial line waiting', () => {
    expect(readStream('data: {"message":1}\n\ndata: {"mess')).toEqual({
      kind: 'stream',
      chunks: [1],
      done: false,
    })
    expect(readStream('data: {"error":{"status":"INTERNAL","message":"boom"}}\n').error).toEqual({
      status: 'INTERNAL',
      message: 'boom',
      details: undefined,
    })
  })
})
