import { describe, expect, it } from 'vitest'
import { EMPTY_FORM, createErrorText, createPlan, formProblems, nextForm } from './user-form'

describe('the New user form', () => {
  it('asks each kind for what it needs', () => {
    expect(Object.keys(formProblems('password', EMPTY_FORM)).toSorted()).toEqual([
      'email',
      'password',
    ])
    expect(Object.keys(formProblems('phone', EMPTY_FORM))).toEqual(['phone'])
    expect(formProblems('anonymous', EMPTY_FORM)).toEqual({})
    expect(Object.keys(formProblems('custom', EMPTY_FORM))).toEqual(['uid'])
    expect(formProblems('federated', { ...EMPTY_FORM, providerId: 'password' }).providerId).toMatch(
      /federated/,
    )
    expect(formProblems('phone', { ...EMPTY_FORM, phone: '555 0100' }).phone).toMatch(/E\.164/)
    expect(formProblems('phone', { ...EMPTY_FORM, phone: '+1 (555) 0100' })).toEqual({})
    expect(
      formProblems('password', {
        ...EMPTY_FORM,
        email: 'a@b',
        password: 'secret1',
        claims: '{"iss":1}',
      }).claims,
    ).toMatch(/FORBIDDEN_CLAIM/)
  })

  it('creates an email user as admin, claims after it', () => {
    const plan = createPlan(
      'password',
      {
        ...EMPTY_FORM,
        email: 'ada@journey.test',
        password: 'password-1',
        emailVerified: true,
        claims: '{"role": "admin"}',
      },
      'acme',
    )
    expect(plan.create).toEqual({
      as: 'admin',
      operation: 'accounts',
      scoped: true,
      body: { email: 'ada@journey.test', emailVerified: true, password: 'password-1' },
    })
    expect(plan.followUps).toEqual([
      {
        as: 'admin',
        operation: 'accounts:update',
        scoped: true,
        body: { customAttributes: '{"role":"admin"}' },
      },
    ])
  })

  it('signs in anonymously as a client, the tenant in the body', () => {
    const plan = createPlan('anonymous', { ...EMPTY_FORM, displayName: 'Guest' }, 'acme')
    expect(plan.create).toEqual({
      as: 'client',
      operation: 'accounts:signUp',
      scoped: false,
      body: { returnSecureToken: true, tenantId: 'acme' },
    })
    expect(plan.followUps).toEqual([
      { as: 'admin', operation: 'accounts:update', scoped: true, body: { displayName: 'Guest' } },
    ])
  })

  it('links the provider of a federated user after creating it', () => {
    const plan = createPlan(
      'federated',
      {
        ...EMPTY_FORM,
        email: 'g@journey.test',
        providerId: 'google.com',
        rawId: '1093',
        password: 'ignored',
      },
      undefined,
    )
    expect(plan.create.body).toEqual({ email: 'g@journey.test', emailVerified: false })
    expect(plan.followUps[0]?.body).toEqual({
      linkProviderUserInfo: { providerId: 'google.com', rawId: '1093', email: 'g@journey.test' },
    })
  })

  it('creates a custom uid and a phone user with what they hold', () => {
    expect(
      createPlan('custom', { ...EMPTY_FORM, uid: 'u_custom', disabled: true }, undefined).create
        .body,
    ).toEqual({
      localId: 'u_custom',
      disabled: true,
    })
    expect(
      createPlan('phone', { ...EMPTY_FORM, phone: '+1 555 0100' }, undefined).create.body,
    ).toEqual({
      phoneNumber: '+15550100',
    })
  })

  it('sends and checks only what the kind asks for, whatever another kind left typed', () => {
    const left = {
      ...EMPTY_FORM,
      email: 'taken@journey.test',
      password: 'password-1',
      phone: '+15550100',
      uid: 'u_typed',
    }
    expect(createPlan('phone', left, undefined).create.body).toEqual({
      phoneNumber: '+15550100',
      localId: 'u_typed',
    })
    expect(createPlan('password', left, undefined).create.body).toEqual({
      email: 'taken@journey.test',
      emailVerified: false,
      password: 'password-1',
      localId: 'u_typed',
    })
    expect(createPlan('federated', left, undefined).create.body).toEqual({
      email: 'taken@journey.test',
      emailVerified: false,
      localId: 'u_typed',
    })
    // A bad value under a hidden field never blocks the kind in view.
    expect(
      formProblems('phone', { ...EMPTY_FORM, phone: '+15550100', email: 'not an email' }),
    ).toEqual({})
    expect(
      formProblems('password', {
        ...EMPTY_FORM,
        email: 'a@b.test',
        password: 'password-1',
        phone: '12',
      }),
    ).toEqual({})
  })

  it('keeps the kind’s choices for the next user and explains refusals', () => {
    expect(
      nextForm({ ...EMPTY_FORM, email: 'x@y', emailVerified: true, providerId: 'github.com' }),
    ).toEqual({
      ...EMPTY_FORM,
      emailVerified: true,
      providerId: 'github.com',
    })
    // The official emulator refuses a second account with an email whatever
    // allowDuplicateEmails says, so the fix is never a switch.
    expect(createErrorText('EMAIL_EXISTS', 'EMAIL_EXISTS')).toMatch(/never shares one/)
    expect(createErrorText('EMAIL_EXISTS', 'EMAIL_EXISTS')).not.toMatch(/Settings/)
    expect(createErrorText('SOMETHING', 'SOMETHING : why')).toBe('SOMETHING : why')
  })
})
