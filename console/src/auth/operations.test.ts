import { describe, expect, it } from 'vitest'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import { authFrontSources } from './engine-sources.test-support'
import { OPERATION_LABELS, callLabel, humanize, operationLabel } from './operations'

describe('what a call was, in words', () => {
  it('labels the operations as a developer calls them', () => {
    expect(operationLabel('identitytoolkit.accounts.signInWithPassword')).toBe(
      'Sign in with password',
    )
    expect(operationLabel('securetoken.token')).toBe('Refresh token')
    expect(operationLabel('identitytoolkit.projects.accounts')).toBe('Create user')
    expect(operationLabel('emulator.action.verifyEmail')).toBe('Verify email (link)')
    expect(operationLabel('emulator.action.somethingNew')).toBe('Open action link')
    expect(operationLabel('firenook.console.users.disable')).toBe('Disable users')
  })

  it('humanises an id it does not know', () => {
    expect(humanize('identitytoolkit.accounts.signInWithMagic')).toBe('Sign in with magic')
    expect(operationLabel('identitytoolkit.v3.somethingElse')).toBe('Something else')
    expect(humanize('')).toBe('')
  })

  it('has a label for every operation the engine dispatches', async () => {
    // The engine's dispatch table (`crates/auth-front/src/lib.rs`).
    const source = (await authFrontSources()).get('lib.rs') ?? ''
    const start = source.indexOf('async fn dispatch(')
    const end = source.indexOf('other => Err(', start)
    const ids = [...source.slice(start, end).matchAll(/"([a-z]+(?:\.[A-Za-z]+)+)"/g)].map(
      (match) => match[1] ?? '',
    )
    expect(ids.length).toBeGreaterThan(50)
    expect(ids.filter((id) => !(id in OPERATION_LABELS))).toEqual([])
  })

  it('says which code a send sent, and that a bare client sign-up is the anonymous one', () => {
    const send: Pick<AuthActivitySummary, 'operation' | 'steps' | 'identifier' | 'caller'> = {
      operation: 'identitytoolkit.accounts.sendOobCode',
      steps: [{ kind: 'message', id: 4, message: 'passwordReset', to: 'ada@example.test' }],
      identifier: 'ada@example.test',
      caller: 'client',
    }
    expect(callLabel(send)).toBe('Send password reset')
    expect(callLabel({ ...send, steps: [] })).toBe('Send code or link')
    expect(
      callLabel({
        operation: 'identitytoolkit.accounts.signUp',
        steps: [],
        identifier: null,
        caller: 'client',
      }),
    ).toBe('Sign up anonymously')
    expect(
      callLabel({
        operation: 'identitytoolkit.accounts.signUp',
        steps: [],
        identifier: 'a@b.test',
        caller: 'client',
      }),
    ).toBe('Sign up')
  })
})
