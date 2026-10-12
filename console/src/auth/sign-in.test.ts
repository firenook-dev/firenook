import { describe, expect, it } from 'vitest'
import {
  EMPTY_FIELDS,
  type TryFields,
  claimsProblem,
  decodeTokenPayload,
  fieldsOfCall,
  finishSecondFactor,
  firstStep,
  methodOfCall,
  missingField,
  pendingSecondFactor,
  secondStep,
  sessionInfoOf,
  signedIn,
  startSecondFactor,
  takeTryDraft,
  tryWith,
} from './sign-in'

const fields = (extra: Partial<TryFields>): TryFields => ({ ...EMPTY_FIELDS, ...extra })
const TOOLKIT = '/identitytoolkit.googleapis.com/v1'

describe('the calls Try makes, as a client', () => {
  it('signs in and up with a password, in the tenant in scope', () => {
    const password = firstStep(
      'password',
      fields({ email: ' ada@example.test ', password: 'pw-1' }),
      'acme',
    )
    expect(password).toEqual({
      method: 'POST',
      path: `${TOOLKIT}/accounts:signInWithPassword`,
      body: {
        email: 'ada@example.test',
        password: 'pw-1',
        returnSecureToken: true,
        tenantId: 'acme',
      },
      as: 'client',
      origin: 'try',
    })
    expect(
      firstStep('signUp', fields({ email: 'a@b.test', password: 'pw-1' }), undefined).path,
    ).toBe(`${TOOLKIT}/accounts:signUp`)
    expect(firstStep('anonymous', fields({}), undefined).body).toEqual({ returnSecureToken: true })
  })

  it('sends a sign-in link, then signs in with its code', () => {
    const send = firstStep(
      'emailLink',
      fields({ email: 'ada@example.test', continueUrl: 'https://app.example/finish' }),
      undefined,
    )
    expect(send.body).toEqual({
      requestType: 'EMAIL_SIGNIN',
      email: 'ada@example.test',
      continueUrl: 'https://app.example/finish',
      canHandleCodeInApp: true,
    })
    const signIn = secondStep(
      'emailLink',
      fields({ email: 'ada@example.test', code: 'oob-1' }),
      undefined,
      undefined,
    )
    expect(signIn.path).toBe(`${TOOLKIT}/accounts:signInWithEmailLink`)
    expect(signIn.body).toEqual({
      email: 'ada@example.test',
      oobCode: 'oob-1',
      returnSecureToken: true,
    })
  })

  it('sends an SMS code, then signs in with the session it answered', () => {
    expect(firstStep('phone', fields({ phone: '+15550100' }), undefined).body).toEqual({
      phoneNumber: '+15550100',
    })
    expect(secondStep('phone', fields({ code: ' 482913 ' }), 'session-1', undefined).body).toEqual({
      sessionInfo: 'session-1',
      code: '482913',
      returnSecureToken: true,
    })
    expect(sessionInfoOf({ sessionInfo: 's' })).toBe('s')
    expect(sessionInfoOf({ phoneResponseInfo: { sessionInfo: 'm' } })).toBe('m')
  })

  it('makes a custom token the emulator accepts, and a provider credential', () => {
    const custom = firstStep(
      'customToken',
      fields({ uid: 'u_ada', claims: '{"role":"admin"}' }),
      undefined,
    )
    expect(JSON.parse(String((custom.body as { token: string }).token))).toEqual({
      uid: 'u_ada',
      claims: { role: 'admin' },
    })
    const federated = firstStep(
      'federated',
      fields({ providerId: 'google.com', email: 'ada@gmail.example', name: 'Ada' }),
      undefined,
    )
    const postBody = new URLSearchParams(String((federated.body as { postBody: string }).postBody))
    expect(JSON.parse(postBody.get('id_token') ?? '')).toEqual({
      sub: 'ada@gmail.example',
      email: 'ada@gmail.example',
      name: 'Ada',
    })
    expect(postBody.get('providerId')).toBe('google.com')
  })

  it('refreshes at the token endpoint', () => {
    const refresh = firstStep('refresh', fields({ refreshToken: 'r-1' }), 'acme')
    expect(refresh).toMatchObject({
      path: '/securetoken.googleapis.com/v1/token',
      body: { grant_type: 'refresh_token', refresh_token: 'r-1' },
      origin: 'try',
    })
  })

  it('continues into a second factor', () => {
    const answer = {
      mfaPendingCredential: 'pending-1',
      mfaInfo: [{ mfaEnrollmentId: 'e1', phoneInfo: '+*******0199', displayName: 'Work phone' }],
    }
    expect(pendingSecondFactor(answer)).toEqual({
      credential: 'pending-1',
      factors: [{ mfaEnrollmentId: 'e1', phone: '+*******0199', displayName: 'Work phone' }],
    })
    expect(pendingSecondFactor({ idToken: 'x' })).toBeUndefined()
    expect(startSecondFactor('pending-1', 'e1', undefined)).toMatchObject({
      path: '/identitytoolkit.googleapis.com/v2/accounts/mfaSignIn:start',
      body: { mfaPendingCredential: 'pending-1', mfaEnrollmentId: 'e1', phoneSignInInfo: {} },
    })
    expect(finishSecondFactor('pending-1', 's-1', ' 123456 ', 'acme').body).toEqual({
      mfaPendingCredential: 'pending-1',
      phoneVerificationInfo: { sessionInfo: 's-1', code: '123456' },
      tenantId: 'acme',
    })
  })
})

describe('what Try needs before it can send', () => {
  it('names the missing field', () => {
    expect(missingField('password', fields({}))).toBe('Enter an email.')
    expect(missingField('password', fields({ email: 'a@b.test' }))).toBe('Enter a password.')
    expect(missingField('anonymous', fields({}))).toBeUndefined()
    expect(
      missingField('emailLink', fields({ email: 'a@b.test', continueUrl: 'finish' })),
    ).toContain('full URL')
    expect(missingField('customToken', fields({ uid: 'u', claims: '[1]' }))).toContain(
      'JSON object',
    )
    expect(missingField('refresh', fields({}))).toContain('refresh token')
    expect(claimsProblem('{')).toMatch(/^The claims are not JSON/)
  })
})

describe('an answer', () => {
  it('reads the tokens in either shape', () => {
    expect(signedIn({ idToken: 'i', refreshToken: 'r', localId: 'u', isNewUser: true })).toEqual({
      idToken: 'i',
      refreshToken: 'r',
      uid: 'u',
      isNewUser: true,
    })
    expect(signedIn({ id_token: 'i', refresh_token: 'r', user_id: 'u' })).toEqual({
      idToken: 'i',
      refreshToken: 'r',
      uid: 'u',
      isNewUser: undefined,
    })
    expect(signedIn({ email: 'a@b.test' })).toBeUndefined()
  })

  it('decodes an unsigned token’s payload, unicode included', () => {
    const payload = { sub: 'u_ada', name: 'Adä 🔥' }
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
    expect(decodeTokenPayload(`e30.${encoded}.`)).toEqual(payload)
    expect(decodeTokenPayload('not-a-token')).toBeUndefined()
  })
})

describe('edit and run again', () => {
  it('maps a recorded call onto a method and its fields', () => {
    const call = {
      operation: 'identitytoolkit.accounts.signInWithPassword',
      identifier: 'ada@example.test',
      caller: 'client' as const,
      provider: 'password',
      uid: null,
    }
    expect(methodOfCall(call)).toBe('password')
    expect(fieldsOfCall(call, 'password')).toEqual({ email: 'ada@example.test' })
    expect(
      methodOfCall({ ...call, operation: 'identitytoolkit.accounts.signUp', identifier: null }),
    ).toBe('anonymous')
    expect(
      methodOfCall({ ...call, operation: 'identitytoolkit.accounts.sendVerificationCode' }),
    ).toBe('phone')
    expect(methodOfCall({ ...call, operation: 'securetoken.token' })).toBe('refresh')
    expect(methodOfCall({ ...call, operation: 'identitytoolkit.accounts.lookup' })).toBeUndefined()
    expect(
      fieldsOfCall({ identifier: '+15550100', provider: 'phone', uid: null }, 'phone'),
    ).toEqual({ phone: '+15550100' })
  })

  it('hands fields to Try once', () => {
    tryWith({ email: 'ada@example.test' })
    expect(takeTryDraft()).toEqual({ email: 'ada@example.test' })
    expect(takeTryDraft()).toBeUndefined()
  })
})
