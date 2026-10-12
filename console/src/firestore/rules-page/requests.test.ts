import { describe, expect, it } from 'vitest'
import {
  EMPTY_FORM,
  describeForm,
  formFromRequest,
  pathProblem,
  toEvaluateRequest,
} from './requests'

const P = 'demo-p'
const D = '(default)'

function claimsOf(authorization: string | null | undefined): Record<string, unknown> {
  const payload = (authorization ?? '').replace('Bearer ', '').split('.')[1] ?? ''
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
  return JSON.parse(json) as Record<string, unknown>
}

describe('a playground request', () => {
  it('checks the path against the operation', () => {
    expect(pathProblem('get', 'users', false)).toMatch(/even number/)
    expect(pathProblem('get', '/users/u1/', false)).toBeUndefined()
    expect(pathProblem('list', 'users/u1', false)).toMatch(/collection/)
    expect(pathProblem('list', 'orders', true)).toBeUndefined()
    expect(pathProblem('list', 'users/u1/orders', true)).toMatch(/collection id/)
    expect(pathProblem('create', '', false)).toMatch(/Name the document/)
  })

  it('reads anonymously, or as a user with a token minted like the SDK mints one', () => {
    const anonymous = toEvaluateRequest({ ...EMPTY_FORM, path: 'users/u1' }, P, D)
    expect(anonymous).toEqual({ request: { method: 'get', path: 'users/u1', auth: null } })
    const signed = toEvaluateRequest(
      {
        ...EMPTY_FORM,
        path: 'users/u1',
        who: { kind: 'user', uid: 'u1', email: 'ada@example.test', claims: '{"admin": true}' },
      },
      P,
      D,
    )
    if (!('request' in signed)) throw new Error(signed.error)
    const claims = claimsOf(signed.request.authorization)
    expect(claims).toMatchObject({ sub: 'u1', email: 'ada@example.test', admin: true, aud: P })
    // The identity a saved test exports as: verified email, password provider.
    expect(claims).toMatchObject({
      email_verified: true,
      firebase: { sign_in_provider: 'password' },
    })
  })

  it('types the data of a write the way the grid types it', () => {
    const result = toEvaluateRequest(
      {
        ...EMPTY_FORM,
        method: 'create',
        path: 'users/u1',
        data: '{"name": "Ada", "seats": 3, "since": "2026-09-20T09:00:00Z", "tags": ["a"]}',
      },
      P,
      D,
    )
    if (!('request' in result)) throw new Error(result.error)
    expect(result.request.data).toEqual({
      name: { stringValue: 'Ada' },
      seats: { integerValue: '3' },
      since: { timestampValue: '2026-09-20T09:00:00.000Z' },
      tags: { arrayValue: { values: [{ stringValue: 'a' }] } },
    })
  })

  it('says what is wrong with the data or the claims', () => {
    expect(
      toEvaluateRequest({ ...EMPTY_FORM, method: 'update', path: 'a/b', data: '[1]' }, P, D),
    ).toEqual({ error: expect.stringMatching(/JSON object/) as unknown as string })
    expect(
      toEvaluateRequest(
        { ...EMPTY_FORM, path: 'a/b', who: { kind: 'user', uid: 'u', claims: '{nope' } },
        P,
        D,
      ),
    ).toEqual({ error: expect.stringMatching(/not JSON/) as unknown as string })
  })

  it('structures a list query the way the grid does', () => {
    const result = toEvaluateRequest(
      {
        ...EMPTY_FORM,
        method: 'list',
        path: 'users',
        query: 'where("plan", "==", "pro").limit(5)',
      },
      P,
      D,
    )
    if (!('request' in result)) throw new Error(result.error)
    expect(result.request.query).toEqual({
      where: {
        fieldFilter: { field: { fieldPath: 'plan' }, op: 'EQUAL', value: { stringValue: 'pro' } },
      },
      limit: 5,
    })
  })

  it('replays a recorded request as it was, and reads back as a line', () => {
    const form = formFromRequest(
      {
        method: 'update',
        path: 'users/u1',
        auth: { uid: 'u1', token: { email: 'ada@example.test' } },
        data: {
          seats: { integerValue: '11' },
          meta: { mapValue: { fields: { a: { nullValue: null } } } },
        },
        resource: { seats: { integerValue: '10' } },
        time: '2026-09-20T09:00:00Z',
      },
      'r-1',
    )
    expect(JSON.parse(form.data)).toEqual({ seats: 11, meta: { a: null } })
    expect(describeForm(form)).toBe('update users/u1 as u1')
    const back = toEvaluateRequest(form, P, D)
    if (!('request' in back)) throw new Error(back.error)
    expect(back.request).toMatchObject({
      auth: { uid: 'u1', token: { email: 'ada@example.test' } },
      resource: { seats: { integerValue: '10' } },
      time: '2026-09-20T09:00:00Z',
    })
  })
})
