import { describe, expect, it } from 'vitest'
import type { AuthUserDetail } from '@/api/generated/auth/AuthUserDetail'
import { userAsCode } from './code'

function detail(
  extra: Omit<Partial<AuthUserDetail>, 'row'> & { row?: Partial<AuthUserDetail['row']> } = {},
): AuthUserDetail {
  const { row, ...rest } = extra
  return {
    row: {
      uid: 'u_ada',
      tenant: null,
      email: 'ada@example.test',
      emailVerified: true,
      phoneNumber: null,
      displayName: 'Ada "the first" Lovelace',
      photoUrl: null,
      providers: ['password'],
      anonymous: false,
      disabled: false,
      mfa: 0,
      claimKeys: [],
      customAuth: false,
      createdAt: 1_700_000_000_000,
      lastSignInAt: null,
      ...row,
    },
    password: 'password-1',
    passwordOpaque: false,
    passwordUpdatedAt: null,
    validSince: null,
    lastRefreshAt: null,
    initialEmail: null,
    emailLinkSignIn: false,
    providerInfo: [
      {
        providerId: 'password',
        rawId: 'ada@example.test',
        email: 'ada@example.test',
        displayName: null,
        photoUrl: null,
        phoneNumber: null,
        federatedId: null,
        screenName: null,
      },
    ],
    mfa: [],
    passkeys: [],
    claimsText: null,
    claims: null,
    claimsLength: 0,
    record: { localId: 'u_ada', email: 'ada@example.test', passwordHash: 'ZmFrZUhhc2g=' },
    ...rest,
  }
}

const context = { project: 'demo-x', authAddress: '127.0.0.1:9099' }

describe('a user as code', () => {
  it('writes a password user as createUser, the strings escaped', () => {
    const code = userAsCode(detail(), 'node', context)
    expect(code).toContain("import { getAuth } from 'firebase-admin/auth'")
    expect(code).toContain('await auth.createUser({')
    expect(code).toContain('password: "password-1"')
    expect(code).toContain('displayName: "Ada \\"the first\\" Lovelace"')
    expect(code).not.toContain('setCustomUserClaims')
    expect(code).not.toContain('importUsers')
  })

  it('sends the user to the Auth emulator, not to the project’s real Auth', () => {
    // Without FIREBASE_AUTH_EMULATOR_HOST the Admin SDKs create the user in
    // production, so the code sets it rather than naming it in a comment.
    const node = userAsCode(detail(), 'node', context).split('\n')
    const set = node.indexOf('process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099"')
    expect(set).toBeGreaterThan(-1)
    expect(set).toBeLessThan(node.findIndex((line) => line.startsWith('initializeApp(')))
    const python = userAsCode(detail(), 'python', context).split('\n')
    expect(python.slice(0, 2)).toEqual([
      'import os',
      'os.environ.setdefault("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099")',
    ])
    expect(python.join('\n')).not.toContain('# FIREBASE_AUTH_EMULATOR_HOST')
  })

  it('writes a phone user without an email or a password', () => {
    const phone = detail({
      row: { email: null, phoneNumber: '+15550100', displayName: null, providers: ['phone'] },
      password: null,
      providerInfo: [],
    })
    const node = userAsCode(phone, 'node', context)
    expect(node).toContain('phoneNumber: "+15550100"')
    expect(node).not.toContain('email')
    expect(node).not.toContain('password')
    const python = userAsCode(phone, 'python', context)
    expect(python).toContain('phone_number="+15550100"')
    expect(python).not.toContain('email_verified')
  })

  it('imports a federated user, since createUser cannot link a provider', () => {
    const federated = detail({
      providerInfo: [
        ...detail().providerInfo,
        {
          providerId: 'google.com',
          rawId: '1093',
          email: 'ada@gmail.example',
          displayName: 'Ada',
          photoUrl: null,
          phoneNumber: null,
          federatedId: null,
          screenName: null,
        },
      ],
      claims: { role: 'admin' },
    })
    const node = userAsCode(federated, 'node', context)
    expect(node).toContain('await auth.importUsers([')
    expect(node).toContain('providerId: "google.com"')
    expect(node).toContain('customClaims: {')
    expect(node).toContain('await auth.updateUser("u_ada", { password: "password-1" })')
    expect(node).not.toContain('auth.createUser')
    const python = userAsCode(federated, 'python', context)
    expect(python).toContain('auth.ImportUserRecord(')
    expect(python).toContain('provider_id="google.com"')
    expect(python).toContain('custom_claims={')
  })

  it('carries second factors and claims, and a tenant through the tenant manager', () => {
    const mfa = detail({
      mfa: [
        { enrollmentId: 'e1', displayName: 'Work', phoneNumber: '+15550199', enrolledAt: null },
      ],
      claims: { admin: true, plan: null },
    })
    const node = userAsCode(mfa, 'node', { ...context, tenant: 'acme' })
    expect(node).toContain('getAuth().tenantManager().authForTenant("acme")')
    expect(node).toContain('factorId: "phone"')
    expect(node).toContain('phoneNumber: "+15550199"')
    expect(node).toContain('await auth.setCustomUserClaims("u_ada", {')
    const python = userAsCode(mfa, 'python', { ...context, tenant: 'acme' })
    expect(python).toContain('from firebase_admin import auth, tenant_mgt')
    expect(python).toContain('client.set_custom_user_claims("u_ada", {')
    expect(python).toContain('"admin": True')
    expect(python).toContain('"plan": None')
    // The import line names only what the body uses.
    expect(userAsCode(detail(), 'python', context)).toContain('from firebase_admin import auth\n')
  })

  it('writes the record itself for REST and accounts.json, quoted for the shell', () => {
    const rest = userAsCode(detail({ record: { localId: "o'brien" } }), 'rest', {
      ...context,
      tenant: 'acme',
    })
    expect(rest).toContain(
      "'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-x/tenants/acme/accounts:batchCreate'",
    )
    expect(rest).toContain("o'\\''brien")
    expect(JSON.parse(userAsCode(detail(), 'accounts', context))).toEqual(detail().record)
  })
})
