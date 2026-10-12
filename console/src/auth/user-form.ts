// The New user dialog's form: what each kind of account asks for, what is
// wrong with it before the engine is asked, and the calls that create it —
// the official API, as the Admin SDK or the app's SDK makes them, so the
// account is exactly what code would have made and Activity records it:
//
// - Email & password, Phone, Custom uid: `POST …/accounts` as admin (what
//   `createUser` sends), then `accounts:update { customAttributes }` when
//   claims were given (`setCustomUserClaims`);
// - Anonymous: `accounts:signUp {}` as a client, exactly
//   `signInAnonymously()`;
// - Federated: created as admin, then `linkProviderUserInfo`.
//
// A refusal is explained with its fix (`createErrorText`).

import { readClaims } from './claims'

export type NewUserKind = 'password' | 'phone' | 'anonymous' | 'federated' | 'custom'

export const NEW_USER_KINDS: readonly { id: NewUserKind; label: string }[] = [
  { id: 'password', label: 'Email & password' },
  { id: 'phone', label: 'Phone' },
  { id: 'anonymous', label: 'Anonymous' },
  { id: 'federated', label: 'Federated' },
  { id: 'custom', label: 'Custom uid' },
]

export interface NewUserForm {
  email: string
  emailVerified: boolean
  password: string
  displayName: string
  photoUrl: string
  /** Empty for a generated uid (required for Custom uid). */
  uid: string
  phone: string
  disabled: boolean
  /** Federated: the provider and its own id for the user. */
  providerId: string
  rawId: string
  /** Optional custom claims, as JSON. */
  claims: string
}

export const EMPTY_FORM: NewUserForm = {
  email: '',
  emailVerified: false,
  password: '',
  displayName: '',
  photoUrl: '',
  uid: '',
  phone: '',
  disabled: false,
  providerId: 'google.com',
  rawId: '',
  claims: '',
}

/** The form after "Create and add another": cleared, the kind's choices kept. */
export function nextForm(form: NewUserForm): NewUserForm {
  return { ...EMPTY_FORM, emailVerified: form.emailVerified, providerId: form.providerId }
}

export type FormProblems = Partial<Record<keyof NewUserForm, string>>

const EMAIL = /^[^@\s]+@[^@\s]+$/

/** The phone as the engine stores it: E.164, punctuation dropped. */
export function e164(phone: string): string {
  return phone.replace(/[\s().-]/g, '')
}

/** What is wrong with the form for this kind, by field. */
export function formProblems(kind: NewUserKind, form: NewUserForm): FormProblems {
  const problems: FormProblems = {}
  const email = form.email.trim()
  const needsEmail = kind === 'password'
  if (needsEmail && email === '') problems.email = 'An email address is needed for this kind.'
  else if (email !== '' && !EMAIL.test(email))
    problems.email = 'An email address has one @ with text on both sides.'
  if (kind === 'password' && form.password.length < 6)
    problems.password = 'At least 6 characters, as Firebase requires.'
  if (kind === 'custom' && form.password !== '' && form.password.length < 6)
    problems.password = 'At least 6 characters, as Firebase requires.'
  const phone = e164(form.phone)
  if (kind === 'phone' && phone === '') problems.phone = 'A phone number is needed for this kind.'
  else if (phone !== '' && !/^\+[1-9]\d{1,14}$/.test(phone))
    problems.phone = 'A phone number is + then the country code and number (E.164), like +15550100.'
  if (kind === 'custom' && form.uid.trim() === '')
    problems.uid = 'A custom uid is what this kind is for.'
  if (form.uid.length > 128) problems.uid = 'A uid holds at most 128 characters.'
  if (kind === 'federated') {
    if (form.providerId.trim() === '') problems.providerId = 'Which provider, like google.com.'
    else if (['password', 'phone', 'anonymous'].includes(form.providerId.trim()))
      problems.providerId = 'A federated provider, like google.com or saml.my-idp.'
  }
  if (form.photoUrl.trim() !== '' && !/^https?:\/\//.test(form.photoUrl.trim()))
    problems.photoUrl = 'A photo URL starts with http:// or https://.'
  if (form.claims.trim() !== '') {
    const reading = readClaims(form.claims)
    if (!reading.ok) problems.claims = reading.message
  }
  return problems
}

/** One call of a creation, through the console's mount. */
export interface CreateCall {
  /** `admin` with the owner credential; `client` with the API key. */
  as: 'admin' | 'client'
  /** The operation: `accounts` (admin create), `accounts:signUp`, `accounts:update`. */
  operation: 'accounts' | 'accounts:signUp' | 'accounts:update'
  /** Admin calls name the project (and tenant) in the path; client calls send `tenantId`. */
  scoped: boolean
  body: Record<string, unknown>
}

/** What creating this user takes: the create, then (with `localId` filled in) the follow-ups. */
export interface CreatePlan {
  create: CreateCall
  /** Run after the create, with the new uid as `localId`. */
  followUps: CreateCall[]
}

/** The calls that create this account. */
export function createPlan(
  kind: NewUserKind,
  form: NewUserForm,
  tenant: string | undefined,
): CreatePlan {
  const followUps: CreateCall[] = []
  const claims = form.claims.trim() === '' ? undefined : readClaims(form.claims)
  if (kind === 'anonymous') {
    const plan: CreatePlan = {
      create: {
        as: 'client',
        operation: 'accounts:signUp',
        scoped: false,
        body: { returnSecureToken: true, ...(tenant ? { tenantId: tenant } : {}) },
      },
      followUps,
    }
    const profile: Record<string, unknown> = {}
    if (form.displayName.trim()) profile.displayName = form.displayName.trim()
    if (form.photoUrl.trim()) profile.photoUrl = form.photoUrl.trim()
    if (form.disabled) profile.disableUser = true
    if (claims?.ok && claims.compact !== '{}') profile.customAttributes = claims.compact
    if (Object.keys(profile).length > 0)
      followUps.push({ as: 'admin', operation: 'accounts:update', scoped: true, body: profile })
    return plan
  }
  const body: Record<string, unknown> = {}
  const email = form.email.trim()
  if (email) {
    body.email = email
    body.emailVerified = form.emailVerified
  }
  if (form.password !== '' && kind !== 'phone' && kind !== 'federated')
    body.password = form.password
  if (form.displayName.trim()) body.displayName = form.displayName.trim()
  if (form.photoUrl.trim()) body.photoUrl = form.photoUrl.trim()
  const phone = e164(form.phone)
  if (phone !== '') body.phoneNumber = phone
  if (form.uid.trim()) body.localId = form.uid.trim()
  if (form.disabled) body.disabled = true
  if (kind === 'federated')
    followUps.push({
      as: 'admin',
      operation: 'accounts:update',
      scoped: true,
      body: {
        linkProviderUserInfo: {
          providerId: form.providerId.trim(),
          rawId: form.rawId.trim() || `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
          ...(email ? { email } : {}),
          ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
          ...(form.photoUrl.trim() ? { photoUrl: form.photoUrl.trim() } : {}),
        },
      },
    })
  if (claims?.ok && claims.compact !== '{}')
    followUps.push({
      as: 'admin',
      operation: 'accounts:update',
      scoped: true,
      body: { customAttributes: claims.compact },
    })
  return { create: { as: 'admin', operation: 'accounts', scoped: true, body }, followUps }
}

/** Why the emulator refused a create, with what to do about it. */
export function createErrorText(code: string, message: string): string {
  switch (code) {
    case 'EMAIL_EXISTS':
      return 'Another user already has this email. Turn on Allow multiple accounts per email in Settings, or use another.'
    case 'PHONE_NUMBER_EXISTS':
      return 'Another user already has this phone number. Use another.'
    case 'INVALID_PHONE_NUMBER':
      return 'The phone number is not valid: write it as + then the country code and number (E.164), like +15550100.'
    case 'WEAK_PASSWORD':
      return 'The password is too short: Firebase needs at least 6 characters.'
    case 'DUPLICATE_LOCAL_ID':
      return 'Another user already has this uid. Leave it empty for a generated one, or choose another.'
    case 'INVALID_EMAIL':
      return 'The email address is not valid. Write it as name@domain.'
    case 'OPERATION_NOT_ALLOWED':
    case 'ADMIN_ONLY_OPERATION':
      return 'This tenant does not allow this kind of sign-up. Turn it on in Settings (Sign-in behaviour), or create the user as another kind.'
    default:
      return message.includes(code) ? message : `${code}: ${message}`
  }
}
