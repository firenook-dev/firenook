import { describe, expect, it } from 'vitest'
import {
  ENGINE_CODES,
  EXPLANATIONS,
  explainAuthError,
  explanationOf,
  sdkCode,
  sdkMessage,
} from './errors'
import { authFrontSources } from './engine-sources.test-support'
import { SDK_VERSION, SERVER_ERROR_MAP } from './sdk-errors.gen'

describe('the SDK’s names for the emulator’s errors', () => {
  it('come from the pinned @firebase/auth', () => {
    expect(SDK_VERSION).toBe('1.13.5')
    expect(sdkCode('INVALID_LOGIN_CREDENTIALS')).toBe('auth/invalid-credential')
    expect(sdkCode('EMAIL_NOT_FOUND')).toBe('auth/user-not-found')
    expect(sdkCode('INVALID_PASSWORD')).toBe('auth/wrong-password')
    // Answered before the SDK consults its map.
    expect(SERVER_ERROR_MAP.EMAIL_EXISTS).toBe('email-already-in-use')
    expect(SERVER_ERROR_MAP.USER_DISABLED).toBe('user-disabled')
    expect(SERVER_ERROR_MAP.FEDERATED_USER_ID_ALREADY_LINKED).toBe('credential-already-in-use')
  })

  it('follow the SDK’s fallback rule for a code its map does not list', () => {
    expect(sdkCode('FOO_BAR')).toBe('auth/foo-bar')
    expect(sdkCode('WEAK_PASSWORD')).toBe('auth/weak-password')
  })

  it('carry the SDK’s own sentence where it has one', () => {
    expect(sdkMessage('INVALID_PASSWORD')).toBe(
      'The password is invalid or the user does not have a password.',
    )
    expect(sdkMessage('NOT_A_CODE_ANYONE_USES')).toBeUndefined()
  })
})

describe('the explanations', () => {
  it('cover every code the engine answers with, and only those', () => {
    for (const code of ENGINE_CODES) {
      const explained = explanationOf(code)
      expect(explained?.what, code).toMatch(/^[A-Z].*\.$/)
      if (explained?.fix !== undefined) expect(explained.fix, code).toMatch(/^[A-Z].*\.$/)
    }
    expect(Object.keys(EXPLANATIONS).toSorted()).toEqual([...ENGINE_CODES].toSorted())
  })

  it('say what to change, the enumeration case pointing at Settings', () => {
    const explained = explainAuthError('INVALID_LOGIN_CREDENTIALS')
    expect(explained.sdk).toBe('auth/invalid-credential')
    expect(explained.explanation?.what).toBe(
      'Email enumeration protection is on, so a wrong password and an unknown email look the same.',
    )
    expect(explained.explanation?.fix).toBe('Turn it off in Settings to see which.')
    expect(explained.explanation?.settings).toBe(true)
    expect(explainAuthError('INVALID_PASSWORD').explanation?.user).toBe(true)
    expect(explainAuthError('SOMETHING_NEW').explanation).toBeUndefined()
  })

  it('know every code the engine’s sources raise', async () => {
    // The engine's own messages, read from its sources beside the console:
    // every code raised through `ensure!`, `require!` or an `ApiError`
    // constructor is in ENGINE_CODES.
    const sources = await authFrontSources()
    expect(sources.size).toBeGreaterThan(10)
    const raised = new Set<string>()
    const pattern =
      /(?:ensure!\s*\(|require!\s*\(|ApiError::[a-z_]+\(|bad_request\w*\()[\s\S]{0,200}?"([A-Z][A-Z0-9_]{2,})(?: : [^"]*)?"/g
    for (const source of sources.values())
      for (const match of source.matchAll(pattern)) raised.add(match[1] ?? '')
    const known = new Set<string>(ENGINE_CODES)
    // Words the patterns also catch that are not error codes: request
    // types, a sort order, log levels, a status, a placeholder.
    const words = new Set([
      'DESC',
      'EMAIL_SIGNIN',
      'INTERNAL',
      'MESSAGE',
      'NEW_PASSWORD_HERE',
      'PASSWORD_RESET',
      'RECOVER_EMAIL',
      'VERIFY_AND_CHANGE_EMAIL',
      'VERIFY_EMAIL',
      'WARN',
    ])
    expect([...raised].filter((code) => !known.has(code) && !words.has(code))).toEqual([])
  })
})
