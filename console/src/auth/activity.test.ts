import { describe, expect, it } from 'vitest'
import type { AuthActivityDetail } from '@/api/generated/auth/AuthActivityDetail'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import {
  callerChip,
  curlCommand,
  isMaskedPath,
  latencyText,
  parseBody,
  replayBlocked,
  replayRequest,
  stepChips,
  tokenOfRequest,
  triggerOutcomeText,
} from './activity'
import { mayCarryToken } from './components/activity-page'

function summary(extra: Partial<AuthActivitySummary> = {}): AuthActivitySummary {
  return {
    id: 8,
    at: '2026-10-12T10:02:11.204Z',
    durationMicros: 3_120,
    project: 'demo-auth',
    tenant: null,
    caller: 'client',
    origin: null,
    credential: 'apiKey',
    client: 'Chrome/JsCore/11.0.0/FirebaseCore-web',
    method: 'POST',
    path: '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',
    operation: 'identitytoolkit.accounts.signInWithPassword',
    kind: 'sign-in',
    identifier: 'ada@example.test',
    provider: 'password',
    uid: null,
    newUser: null,
    status: 400,
    error: { code: 'INVALID_PASSWORD', message: 'INVALID_PASSWORD' },
    steps: [],
    moreSteps: 0,
    ...extra,
  }
}

function detail(extra: Partial<AuthActivityDetail> = {}): AuthActivityDetail {
  return {
    summary: summary(),
    request: '{"email":"ada@example.test","password":"it\'s wrong","returnSecureToken":true}',
    response: '{"error":{"code":400,"message":"INVALID_PASSWORD"}}',
    requestBytes: 70,
    responseBytes: 50,
    query: [{ name: 'key', value: 'fake-api-key' }],
    headers: [
      { name: 'x-client-version', value: 'Chrome/JsCore/11.0.0/FirebaseCore-web' },
      { name: 'user-agent', value: 'Mozilla/5.0' },
      { name: 'content-type', value: 'application/json' },
    ],
    bodiesDropped: false,
    replayable: true,
    replayEffect: null,
    ...extra,
  }
}

describe('a row of Activity', () => {
  it('says who called, and Replay for a call the developer asked the console to make again', () => {
    expect(callerChip({ caller: 'client', origin: null })).toBe('App')
    expect(callerChip({ caller: 'admin', origin: null })).toBe('Admin')
    expect(callerChip({ caller: 'actionLink', origin: null })).toBe('Link')
    expect(callerChip({ caller: 'console', origin: 'try' })).toBe('Console')
    expect(callerChip({ caller: 'console', origin: 'replay' })).toBe('Replay')
    expect(callerChip({ caller: 'console', origin: 'write' })).toBe('Console')
  })

  it('times a call at the precision it deserves', () => {
    expect(latencyText(120)).toBe('0.1 ms')
    expect(latencyText(3_120)).toBe('3 ms')
    expect(latencyText(41_400)).toBe('41 ms')
    expect(latencyText(1_250_000)).toBe('1.3 s')
    expect(latencyText(61_000_000)).toBe('61 s')
  })

  it('shows what a call caused as chips, a refusal in red', () => {
    const chips = stepChips(
      [
        {
          kind: 'blocking',
          event: 'beforeCreate',
          function: 'beforeCreate',
          uri: 'http://127.0.0.1:5001/p/us-central1/beforeCreate',
          durationMicros: 41_000,
          invocation: null,
          changed: [],
          customClaims: [],
          sessionClaims: [],
          failure: { message: 'Sign-ups from blocked.test are not allowed', status: 403, raw: '…' },
        },
        { kind: 'user', tenant: null, uid: 'u_1', change: 'created', fields: [] },
        { kind: 'trigger', event: 'user.create', uid: 'u_1', outcome: 'queued' },
        { kind: 'message', id: 3, message: 'verifyEmail', to: 'ada@example.test' },
        { kind: 'user', tenant: null, uid: 'u_1', change: 'updated', fields: ['customAttributes'] },
      ],
      2,
    )
    expect(chips).toEqual([
      { text: 'beforeCreate 41 ms', tone: 'danger' },
      { text: 'user.create', tone: undefined },
      { text: 'message' },
      { text: 'claims' },
      { text: '+2 more' },
    ])
    expect(triggerOutcomeText('deliveryOff')).toBe('dropped: background triggers were paused')
    expect(triggerOutcomeText('failed: the queue is closed')).toBe(
      'not queued: the queue is closed',
    )
  })
})

describe('a call’s request', () => {
  it('masks passwords and finds the token it carried', () => {
    expect(isMaskedPath(['password'])).toBe(true)
    expect(isMaskedPath(['user', 'newPassword'])).toBe(true)
    expect(isMaskedPath(['email'])).toBe(false)
    expect(parseBody('<html>')).toEqual({ text: '<html>' })
    expect(parseBody(null)).toBeUndefined()
    expect(tokenOfRequest(detail({ request: '{"idToken":"eyJ.a.b"}' }))).toBe('eyJ.a.b')
    expect(
      tokenOfRequest(detail({ request: '{"grant_type":"refresh_token","refresh_token":"r1"}' })),
    ).toBe('r1')
    expect(tokenOfRequest(detail())).toBeUndefined()
  })

  it('is copied as curl against the Auth emulator, quotes and all', () => {
    const curl = curlCommand(detail(), 'http://127.0.0.1:9099')
    expect(curl.split(' \\\n  ')).toEqual([
      "curl -X POST 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key'",
      "-H 'x-client-version: Chrome/JsCore/11.0.0/FirebaseCore-web'",
      "-H 'content-type: application/json'",
      `--data-raw '{"email":"ada@example.test","password":"it'\\''s wrong","returnSecureToken":true}'`,
    ])
    const owner = curlCommand(
      detail({ summary: summary({ credential: 'owner' }), request: null }),
      'http://[::1]:9099',
    )
    expect(owner).toContain("-H 'authorization: Bearer owner'")
    expect(owner).not.toContain('--data-raw')
  })

  it('is replayed with its credential, query, body and SDK headers, as a replay', () => {
    const request = replayRequest(detail())
    expect(request).toMatchObject({
      method: 'POST',
      path: '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',
      query: { key: 'fake-api-key' },
      as: 'none',
      origin: 'replay',
      headers: { 'x-client-version': 'Chrome/JsCore/11.0.0/FirebaseCore-web' },
    })
    expect(request.body).toEqual({
      email: 'ada@example.test',
      password: "it's wrong",
      returnSecureToken: true,
    })
    expect(replayRequest(detail({ summary: summary({ credential: 'owner' }) })).as).toBe('admin')
  })

  it('says why it cannot be replayed', () => {
    expect(replayBlocked(detail(), true)).toBeUndefined()
    expect(replayBlocked(detail({ replayable: false }), false)).toContain('--no-diagnostics')
    expect(replayBlocked(detail({ replayable: false, bodiesDropped: true }), true)).toContain(
      'dropped',
    )
    expect(
      replayBlocked(
        detail({ replayable: false, summary: summary({ operation: 'firenook.console.mint' }) }),
        true,
      ),
    ).toContain('console’s own')
  })

  it('offers a token to inspect only where a request carries one', () => {
    expect(mayCarryToken({ operation: 'securetoken.token', caller: 'client' })).toBe(true)
    expect(mayCarryToken({ operation: 'identitytoolkit.accounts.lookup', caller: 'client' })).toBe(
      true,
    )
    expect(mayCarryToken({ operation: 'identitytoolkit.accounts.lookup', caller: 'admin' })).toBe(
      false,
    )
    expect(
      mayCarryToken({ operation: 'identitytoolkit.accounts.signInWithPassword', caller: 'client' }),
    ).toBe(false)
  })
})
