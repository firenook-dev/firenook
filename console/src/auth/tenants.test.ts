import { describe, expect, it } from 'vitest'
import type { AuthTenant } from '@/api/generated/auth/AuthTenant'
import {
  NEW_TENANT,
  TENANT_ID_RULE,
  createBody,
  formOfTenant,
  patchOf,
  signInSummary,
  tenantIdProblem,
} from './tenants'

const ACME: AuthTenant = {
  tenantId: 'acme',
  displayName: 'Acme Corp',
  users: 5,
  allowPasswordSignup: true,
  enableEmailLinkSignin: true,
  enableAnonymousUser: false,
  disableAuth: false,
  mfaState: 'ENABLED',
  mfaProviders: ['PHONE_SMS'],
}

describe('tenants', () => {
  it('take the id the console route accepts, or a generated one', () => {
    expect(tenantIdProblem('')).toBeUndefined()
    expect(tenantIdProblem('acme')).toBeUndefined()
    expect(tenantIdProblem('acme-test-2')).toBeUndefined()
    expect(tenantIdProblem('abc')).toBe(TENANT_ID_RULE)
    expect(tenantIdProblem('1acme')).toBe(TENANT_ID_RULE)
    expect(tenantIdProblem('acme_corp')).toBe(TENANT_ID_RULE)
    expect(tenantIdProblem('a'.repeat(21))).toBe(TENANT_ID_RULE)
  })

  it('are created with every field the form holds, the id only when chosen', () => {
    expect(createBody({ ...NEW_TENANT, tenantId: ' acme ', displayName: 'Acme' })).toEqual({
      tenantId: 'acme',
      displayName: 'Acme',
      allowPasswordSignup: true,
      enableEmailLinkSignin: true,
      enableAnonymousUser: true,
      disableAuth: false,
      mfaState: 'DISABLED',
      mfaProviders: ['PHONE_SMS'],
    })
    expect(createBody(NEW_TENANT)).not.toHaveProperty('tenantId')
    expect(createBody({ ...NEW_TENANT, mfaSms: false }).mfaProviders).toEqual([])
  })

  it('are changed with only the fields that changed in the update mask', () => {
    const before = formOfTenant(ACME)
    expect(patchOf(before, before)).toBeUndefined()
    expect(patchOf(before, { ...before, enableAnonymousUser: true })).toEqual({
      body: { enableAnonymousUser: true },
      updateMask: 'enableAnonymousUser',
    })
    expect(patchOf(before, { ...before, displayName: ' Acme ', mfaState: 'MANDATORY' })).toEqual({
      body: {
        displayName: 'Acme',
        mfaConfig: { state: 'MANDATORY', enabledProviders: ['PHONE_SMS'] },
      },
      updateMask: 'displayName,mfaConfig.state,mfaConfig.enabledProviders',
    })
  })

  it('read their sign-in methods in a line', () => {
    expect(signInSummary(ACME)).toBe('password · link · MFA on')
    expect(signInSummary({ ...ACME, disableAuth: true })).toBe('sign-in turned off')
    expect(
      signInSummary({
        ...ACME,
        allowPasswordSignup: false,
        enableEmailLinkSignin: false,
        mfaState: 'DISABLED',
      }),
    ).toBe('no sign-in method')
    expect(signInSummary({ ...ACME, mfaState: 'MANDATORY' })).toBe('password · link · MFA required')
  })
})
