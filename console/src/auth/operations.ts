// What a call to the Auth emulator was, in words: `identitytoolkit.accounts.
// signInWithPassword` reads "Sign in with password". The table covers every
// operation id the engine's dispatch table routes (`crates/auth-front/src/
// lib.rs`, `dispatch` and the pages before it), the action links by mode,
// and the console's own operations (`firenook.console.<action>`); an id it
// does not know is humanised from its last segment, so a new one still
// reads as English.

import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import type { AuthMessageKind } from '@/api/generated/auth/AuthMessageKind'

/**
 * Every operation id the engine routes, as `lib.rs` names them (the
 * `dispatch` match, then `emulator.action.<mode>` and
 * `emulator.accountPicker` from the pages), with its label.
 */
export const OPERATION_LABELS: Readonly<Record<string, string>> = {
  'identitytoolkit.getProjects': 'Read the project settings',
  'identitytoolkit.getRecaptchaParams': 'Read the reCAPTCHA settings',
  'identitytoolkit.accounts.createAuthUri': 'Look up sign-in methods',
  'identitytoolkit.accounts.delete': 'Delete account',
  'identitytoolkit.projects.accounts.delete': 'Delete account',
  'identitytoolkit.projects.tenants.accounts.delete': 'Delete account',
  'identitytoolkit.accounts.lookup': 'Look up account',
  'identitytoolkit.projects.accounts.lookup': 'Look up account',
  'identitytoolkit.projects.tenants.accounts.lookup': 'Look up account',
  'identitytoolkit.accounts.resetPassword': 'Reset password',
  'identitytoolkit.accounts.sendOobCode': 'Send code or link',
  'identitytoolkit.projects.accounts.sendOobCode': 'Send code or link',
  'identitytoolkit.projects.tenants.accounts.sendOobCode': 'Send code or link',
  'identitytoolkit.accounts.sendVerificationCode': 'Send SMS code',
  'identitytoolkit.accounts.signInWithCustomToken': 'Sign in with custom token',
  'identitytoolkit.accounts.signInWithEmailLink': 'Sign in with email link',
  'identitytoolkit.accounts.signInWithIdp': 'Sign in with provider',
  'identitytoolkit.accounts.signInWithPassword': 'Sign in with password',
  'identitytoolkit.accounts.signInWithPhoneNumber': 'Sign in with phone',
  'identitytoolkit.accounts.signUp': 'Sign up',
  'identitytoolkit.projects.accounts': 'Create user',
  'identitytoolkit.projects.tenants.accounts': 'Create user',
  'identitytoolkit.accounts.update': 'Update account',
  'identitytoolkit.projects.accounts.update': 'Update account',
  'identitytoolkit.projects.tenants.accounts.update': 'Update account',
  'identitytoolkit.accounts.mfaEnrollment.finalize': 'Finish MFA enrollment',
  'identitytoolkit.accounts.mfaEnrollment.start': 'Start MFA enrollment',
  'identitytoolkit.accounts.mfaEnrollment.withdraw': 'Remove second factor',
  'identitytoolkit.accounts.mfaSignIn.start': 'Start MFA sign-in',
  'identitytoolkit.accounts.mfaSignIn.finalize': 'Finish MFA sign-in',
  'identitytoolkit.accounts.passkeyEnrollment.start': 'Start passkey enrollment',
  'identitytoolkit.accounts.passkeyEnrollment.finalize': 'Finish passkey enrollment',
  'identitytoolkit.accounts.passkeySignIn.start': 'Start passkey sign-in',
  'identitytoolkit.accounts.passkeySignIn.finalize': 'Sign in with passkey',
  'identitytoolkit.projects.createSessionCookie': 'Create session cookie',
  'identitytoolkit.projects.tenants.createSessionCookie': 'Create session cookie',
  'identitytoolkit.projects.queryAccounts': 'Query accounts',
  'identitytoolkit.projects.accounts.query': 'Query accounts',
  'identitytoolkit.projects.tenants.accounts.query': 'Query accounts',
  'identitytoolkit.projects.getConfig': 'Read config',
  'identitytoolkit.projects.updateConfig': 'Update config',
  'identitytoolkit.projects.accounts.batchCreate': 'Import accounts',
  'identitytoolkit.projects.tenants.accounts.batchCreate': 'Import accounts',
  'identitytoolkit.projects.accounts.batchDelete': 'Delete accounts',
  'identitytoolkit.projects.tenants.accounts.batchDelete': 'Delete accounts',
  'identitytoolkit.projects.accounts.batchGet': 'List accounts',
  'identitytoolkit.projects.tenants.accounts.batchGet': 'List accounts',
  'identitytoolkit.projects.tenants.create': 'Create tenant',
  'identitytoolkit.projects.tenants.delete': 'Delete tenant',
  'identitytoolkit.projects.tenants.get': 'Read tenant',
  'identitytoolkit.projects.tenants.list': 'List tenants',
  'identitytoolkit.projects.tenants.patch': 'Update tenant',
  'securetoken.token': 'Refresh token',
  'emulator.projects.accounts.delete': 'Delete every account',
  'emulator.projects.config.get': 'Read emulator config',
  'emulator.projects.config.update': 'Update emulator config',
  'emulator.projects.oobCodes.list': 'List codes and links',
  'emulator.projects.verificationCodes.list': 'List SMS codes',
  'emulator.accountPicker': 'Account picker',
  'emulator.action.resetPassword': 'Reset password (link)',
  'emulator.action.verifyEmail': 'Verify email (link)',
  'emulator.action.signIn': 'Sign in (link)',
  'emulator.action.verifyAndChangeEmail': 'Change email (link)',
  'emulator.action.recoverEmail': 'Recover email (link)',
  'emulator.action.verifyBeforeChangeEmail': 'Change email (link)',
  'firenook.console.mint': 'Mint a token',
  'firenook.console.createTenant': 'Create tenant',
  'firenook.console.users.disable': 'Disable users',
  'firenook.console.users.enable': 'Enable users',
  'firenook.console.users.verify': 'Verify users’ emails',
  'firenook.console.users.revoke': 'Revoke users’ tokens',
  'firenook.console.users.setClaims': 'Set claims',
  'firenook.console.users.removeClaims': 'Remove claims',
  'firenook.console.users.delete': 'Delete users',
  'firenook.console.users.import': 'Import users',
  'firenook.console.clear': 'Delete every user',
}

/** `signInWithPassword` → "Sign in with password": words from a camel-case segment. */
export function humanize(id: string): string {
  const last = id.split('.').findLast(Boolean) ?? id
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  if (words === '') return id
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

/** An operation id in words. */
export function operationLabel(id: string): string {
  const known = OPERATION_LABELS[id]
  if (known) return known
  if (id.startsWith('emulator.action.')) return 'Open action link'
  return humanize(id)
}

const SEND_LABELS: Readonly<Record<AuthMessageKind, string>> = {
  passwordReset: 'Send password reset',
  verifyEmail: 'Send verification email',
  emailSignIn: 'Send sign-in link',
  verifyAndChangeEmail: 'Send email change',
  recoverEmail: 'Send email recovery',
  smsSignIn: 'Send SMS code',
  smsMfaEnrollment: 'Send MFA enrolment code',
  smsMfaSignIn: 'Send MFA sign-in code',
}

/**
 * A call in words, more exactly than its operation where what it caused
 * says more: `sendOobCode` that sent a password reset reads "Send password
 * reset"; a client sign-up with no identifier is the anonymous one.
 */
export function callLabel(
  call: Pick<AuthActivitySummary, 'operation' | 'steps' | 'identifier' | 'caller'>,
): string {
  if (call.operation.endsWith('.sendOobCode')) {
    for (const step of call.steps) if (step.kind === 'message') return SEND_LABELS[step.message]
  }
  if (
    call.operation === 'identitytoolkit.accounts.signUp' &&
    call.caller === 'client' &&
    !call.identifier
  )
    return 'Sign up anonymously'
  return operationLabel(call.operation)
}
