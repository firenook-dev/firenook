import { describe, expect, it } from 'vitest'
import {
  type BlockingInput,
  blockingBody,
  blockingPayload,
  readBlockingResponse,
  unsignedJwt,
} from './blocking'
import fixture from './fixtures/blocking-jwt.json'

describe('the blocking-function JWT', () => {
  for (const entry of fixture.cases) {
    it(`writes the pinned payload: ${entry.name}`, () => {
      expect(blockingPayload(entry.input as BlockingInput)).toEqual(entry.payload)
    })
  }

  it('posts the unsigned JWT as {data: {jwt}}', () => {
    const input = fixture.cases[0]?.input as BlockingInput
    const body = JSON.parse(blockingBody(input)) as { data: { jwt: string } }
    expect(body.data.jwt).toBe(unsignedJwt(blockingPayload(input)))
    const [header, payload, signature] = body.data.jwt.split('.')
    expect(JSON.parse(atob(header ?? ''))).toEqual({ alg: 'none', typ: 'JWT' })
    expect(signature).toBe('')
    expect(JSON.parse(atob((payload ?? '').replace(/-/g, '+').replace(/_/g, '/')))).toMatchObject({
      sub: 'u_new',
    })
  })

  it('reads the answer as the Auth emulator does', () => {
    expect(
      readBlockingResponse(
        403,
        '{"error":{"status":"PERMISSION_DENIED","message":"Sign-ups from blocked.test are not allowed"}}',
      ),
    ).toEqual({
      kind: 'blocked',
      status: 'PERMISSION_DENIED',
      message: 'Sign-ups from blocked.test are not allowed',
    })
    expect(readBlockingResponse(200, '{}')).toEqual({ kind: 'allowed', changes: {} })
    expect(
      readBlockingResponse(
        200,
        '{"userRecord":{"updateMask":"customClaims,displayName","customClaims":{"tester":true},"displayName":"T","disabled":true}}',
      ),
    ).toEqual({ kind: 'allowed', changes: { customClaims: { tester: true }, displayName: 'T' } })
    expect(readBlockingResponse(200, '{"userRecord":{"displayName":"T"}}')).toEqual({
      kind: 'invalid',
      message: 'Response UserRecord is missing updateMask.',
    })
    expect(readBlockingResponse(500, 'boom').kind).toBe('invalid')
  })
})
