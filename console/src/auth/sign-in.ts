// Try a sign-in: every way an app signs someone in, made from the console
// exactly as a client of the emulator makes it — the client endpoints, the
// API key, the tenant in the body — so the answer, the error and what the
// call caused (blocking functions included) are the app's. A step that sends
// a code (an email link, an SMS) is followed by reading the code that very
// call created (`GET /auth/messages?activity=<its id>`), never by racing the
// feed for whatever arrived last.
//
// Pure where it can be: the requests each method sends, how an answer reads
// (tokens, the second factors it asks for), a call to prefill from. The
// panel (`components/try-sign-in.tsx`) runs them.

import { create } from 'zustand'
import type { AuthActivitySummary } from '@/api/generated/auth/AuthActivitySummary'
import { type EmulatorRequest, SECURE_TOKEN_PATH, toolkitPath } from './api'

/** The methods Try offers, as `?method=` writes them. */
export const METHODS = [
  'password',
  'signUp',
  'anonymous',
  'emailLink',
  'phone',
  'customToken',
  'federated',
  'refresh',
] as const

export type TryMethod = (typeof METHODS)[number]

export const METHOD_LABELS: Readonly<Record<TryMethod, string>> = {
  password: 'Password',
  signUp: 'Sign up',
  anonymous: 'Anonymous',
  emailLink: 'Email link',
  phone: 'Phone',
  customToken: 'Custom token',
  federated: 'Federated',
  refresh: 'Refresh',
}

/** What the SDK call each method stands for, said under the form. */
export const METHOD_CALLS: Readonly<Record<TryMethod, string>> = {
  password: 'signInWithEmailAndPassword',
  signUp: 'createUserWithEmailAndPassword',
  anonymous: 'signInAnonymously',
  emailLink: 'sendSignInLinkToEmail, then signInWithEmailLink',
  phone: 'signInWithPhoneNumber, then confirm(code)',
  customToken: 'signInWithCustomToken',
  federated: 'signInWithCredential (a provider’s ID token)',
  refresh: 'the SDK’s token refresh (getIdToken(true))',
}

/** Everything the forms hold; each method reads its own fields. */
export interface TryFields {
  email: string
  password: string
  phone: string
  continueUrl: string
  /** The code step 2 sends: the SMS code, or the link's oobCode. */
  code: string
  uid: string
  /** Custom claims for a custom token, as JSON text. */
  claims: string
  providerId: string
  subject: string
  name: string
  refreshToken: string
}

export const EMPTY_FIELDS: TryFields = {
  email: '',
  password: '',
  phone: '',
  continueUrl: '',
  code: '',
  uid: '',
  claims: '',
  providerId: 'google.com',
  subject: '',
  name: '',
  refreshToken: '',
}

/** The page a sign-in link returns to when nobody named one: what the field's placeholder shows. */
export const CONTINUE_PLACEHOLDER = 'https://your-app.example/finish'

/** A client call of the emulator's own project, as Try sends it. */
function clientCall(
  operation: string,
  body: Record<string, unknown>,
  tenant: string | undefined,
): EmulatorRequest {
  return {
    method: 'POST',
    path: toolkitPath(operation),
    body: tenant ? { ...body, tenantId: tenant } : body,
    as: 'client',
    origin: 'try',
  }
}

/** Why a method's first step cannot be sent yet, or nothing when it can. */
export function missingField(method: TryMethod, fields: TryFields): string | undefined {
  switch (method) {
    case 'password':
    case 'signUp':
      if (fields.email.trim() === '') return 'Enter an email.'
      if (fields.password === '') return 'Enter a password.'
      return undefined
    case 'anonymous':
      return undefined
    case 'emailLink':
      if (fields.email.trim() === '') return 'Enter an email.'
      if (!isAbsoluteUrl(fields.continueUrl))
        return 'Enter the page the link returns to, a full URL.'
      return undefined
    case 'phone':
      return fields.phone.trim() === '' ? 'Enter a phone number, such as +15550100.' : undefined
    case 'customToken':
      if (fields.uid.trim() === '') return 'Enter the uid the token signs in as.'
      return claimsProblem(fields.claims)
    case 'federated':
      if (fields.providerId.trim() === '') return 'Enter a provider id, such as google.com.'
      return fields.subject.trim() === '' && fields.email.trim() === ''
        ? 'Enter the provider’s account id or an email.'
        : undefined
    case 'refresh':
      return fields.refreshToken.trim() === ''
        ? 'Paste a refresh token, or sign in first.'
        : undefined
  }
}

function isAbsoluteUrl(url: string): boolean {
  try {
    return new URL(url).protocol.startsWith('http')
  } catch {
    return false
  }
}

/** What is wrong with a custom token's claims text, or nothing (empty is no claims). */
export function claimsProblem(claims: string): string | undefined {
  if (claims.trim() === '') return undefined
  try {
    const value: unknown = JSON.parse(claims)
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return 'Claims are a JSON object, such as {"role": "admin"}.'
    return undefined
  } catch (error) {
    return error instanceof Error
      ? `The claims are not JSON: ${error.message}`
      : 'The claims are not JSON.'
  }
}

/**
 * The first call a method makes. For an email link and a phone number it
 * sends the code; the second call (`secondStep`) uses it.
 */
export function firstStep(
  method: TryMethod,
  fields: TryFields,
  tenant: string | undefined,
): EmulatorRequest {
  switch (method) {
    case 'password':
      return clientCall(
        'accounts:signInWithPassword',
        { email: fields.email.trim(), password: fields.password, returnSecureToken: true },
        tenant,
      )
    case 'signUp':
      return clientCall(
        'accounts:signUp',
        { email: fields.email.trim(), password: fields.password, returnSecureToken: true },
        tenant,
      )
    case 'anonymous':
      return clientCall('accounts:signUp', { returnSecureToken: true }, tenant)
    case 'emailLink':
      return clientCall(
        'accounts:sendOobCode',
        {
          requestType: 'EMAIL_SIGNIN',
          email: fields.email.trim(),
          continueUrl: fields.continueUrl.trim(),
          canHandleCodeInApp: true,
        },
        tenant,
      )
    case 'phone':
      return clientCall(
        'accounts:sendVerificationCode',
        { phoneNumber: fields.phone.trim() },
        tenant,
      )
    case 'customToken': {
      const claims =
        fields.claims.trim() === '' ? undefined : (JSON.parse(fields.claims) as unknown)
      const token = JSON.stringify(
        claims === undefined ? { uid: fields.uid.trim() } : { uid: fields.uid.trim(), claims },
      )
      return clientCall(
        'accounts:signInWithCustomToken',
        { token, returnSecureToken: true },
        tenant,
      )
    }
    case 'federated': {
      const subject = fields.subject.trim() || fields.email.trim()
      const idToken: Record<string, string> = { sub: subject }
      if (fields.email.trim()) idToken.email = fields.email.trim()
      if (fields.name.trim()) idToken.name = fields.name.trim()
      const postBody = `id_token=${encodeURIComponent(JSON.stringify(idToken))}&providerId=${encodeURIComponent(fields.providerId.trim())}`
      return clientCall(
        'accounts:signInWithIdp',
        {
          requestUri: 'http://localhost',
          postBody,
          returnSecureToken: true,
          returnIdpCredential: true,
        },
        tenant,
      )
    }
    case 'refresh':
      return {
        method: 'POST',
        path: SECURE_TOKEN_PATH,
        body: { grant_type: 'refresh_token', refresh_token: fields.refreshToken.trim() },
        as: 'client',
        origin: 'try',
      }
  }
}

/** Whether a method sends a code first and signs in with it second. */
export function twoSteps(method: TryMethod): boolean {
  return method === 'emailLink' || method === 'phone'
}

/** The second call: sign in with the code the first one sent. */
export function secondStep(
  method: 'emailLink' | 'phone',
  fields: TryFields,
  sessionInfo: string | undefined,
  tenant: string | undefined,
): EmulatorRequest {
  if (method === 'emailLink')
    return clientCall(
      'accounts:signInWithEmailLink',
      { email: fields.email.trim(), oobCode: fields.code.trim(), returnSecureToken: true },
      tenant,
    )
  return clientCall(
    'accounts:signInWithPhoneNumber',
    { sessionInfo, code: fields.code.trim(), returnSecureToken: true },
    tenant,
  )
}

// ------------------------------------------------------------------ answers

/** The tokens and the account an answer names, whichever shape it came in. */
export interface SignedIn {
  idToken: string
  refreshToken: string | undefined
  uid: string | undefined
  isNewUser: boolean | undefined
}

/** A successful answer's tokens: the Identity Toolkit's camel case or the token endpoint's snake case. */
export function signedIn(answer: unknown): SignedIn | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined
  const record = answer as Record<string, unknown>
  const idToken = text(record.idToken) ?? text(record.id_token)
  if (!idToken) return undefined
  return {
    idToken,
    refreshToken: text(record.refreshToken) ?? text(record.refresh_token),
    uid: text(record.localId) ?? text(record.user_id),
    isNewUser: typeof record.isNewUser === 'boolean' ? record.isNewUser : undefined,
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Where the multi-factor calls are: the Identity Toolkit's v2 accounts. */
const MFA_PATH = '/identitytoolkit.googleapis.com/v2/accounts'

/** A second factor an answer asks for. */
export interface PendingFactor {
  mfaEnrollmentId: string
  /** The masked number the emulator shows a client. */
  phone: string | undefined
  displayName: string | undefined
}

/** The second factor step a sign-in stopped at, when it did. */
export function pendingSecondFactor(
  answer: unknown,
): { credential: string; factors: PendingFactor[] } | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined
  const record = answer as Record<string, unknown>
  const credential = text(record.mfaPendingCredential)
  if (!credential) return undefined
  const info = Array.isArray(record.mfaInfo) ? record.mfaInfo : []
  const factors = info.flatMap((entry): PendingFactor[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const factor = entry as Record<string, unknown>
    const id = text(factor.mfaEnrollmentId)
    return id
      ? [
          {
            mfaEnrollmentId: id,
            phone: text(factor.phoneInfo),
            displayName: text(factor.displayName),
          },
        ]
      : []
  })
  return { credential, factors }
}

/** `mfaSignIn:start` for one factor: the emulator sends that factor's SMS code. */
export function startSecondFactor(
  credential: string,
  enrollmentId: string,
  tenant: string | undefined,
): EmulatorRequest {
  return {
    method: 'POST',
    path: `${MFA_PATH}/mfaSignIn:start`,
    body: {
      mfaPendingCredential: credential,
      mfaEnrollmentId: enrollmentId,
      phoneSignInInfo: {},
      ...(tenant ? { tenantId: tenant } : {}),
    },
    as: 'client',
    origin: 'try',
  }
}

/** `mfaSignIn:finalize` with the code: the sign-in ends with both factors. */
export function finishSecondFactor(
  credential: string,
  sessionInfo: string,
  code: string,
  tenant: string | undefined,
): EmulatorRequest {
  return {
    method: 'POST',
    path: `${MFA_PATH}/mfaSignIn:finalize`,
    body: {
      mfaPendingCredential: credential,
      phoneVerificationInfo: { sessionInfo, code: code.trim() },
      ...(tenant ? { tenantId: tenant } : {}),
    },
    as: 'client',
    origin: 'try',
  }
}

/** `sessionInfo` of a code-sending answer (`sendVerificationCode`, `mfaSignIn:start`). */
export function sessionInfoOf(answer: unknown): string | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined
  const record = answer as Record<string, unknown>
  const direct = text(record.sessionInfo)
  if (direct) return direct
  const info = record.phoneResponseInfo
  return typeof info === 'object' && info !== null
    ? text((info as Record<string, unknown>).sessionInfo)
    : undefined
}

/** An unsigned ID token's payload, decoded where the console holds it. */
export function decodeTokenPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split('.')[1]
  if (!part) return undefined
  try {
    const base64 = part.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

// ------------------------------------------------------------------ edit and run again

/** The Try method a recorded call was, for "Edit and run again", or nothing when Try has none. */
export function methodOfCall(
  call: Pick<AuthActivitySummary, 'operation' | 'identifier' | 'caller' | 'provider'>,
): TryMethod | undefined {
  const name = call.operation.replace(/^identitytoolkit\./, '')
  switch (name) {
    case 'accounts.signInWithPassword':
      return 'password'
    case 'accounts.signUp':
      return call.identifier ? 'signUp' : 'anonymous'
    case 'accounts.signInWithEmailLink':
      return 'emailLink'
    case 'accounts.sendOobCode':
      return 'emailLink'
    case 'accounts.sendVerificationCode':
    case 'accounts.signInWithPhoneNumber':
      return 'phone'
    case 'accounts.signInWithCustomToken':
      return 'customToken'
    case 'accounts.signInWithIdp':
      return 'federated'
    case 'securetoken.token':
      return 'refresh'
    default:
      return undefined
  }
}

/** The fields a call fills in: its email or phone, its provider. */
export function fieldsOfCall(
  call: Pick<AuthActivitySummary, 'identifier' | 'provider' | 'uid'>,
  method: TryMethod,
): Partial<TryFields> {
  const identifier = call.identifier ?? ''
  switch (method) {
    case 'phone':
      return { phone: identifier }
    case 'customToken':
      return { uid: call.uid ?? '' }
    case 'federated':
      return {
        providerId: call.provider ?? 'google.com',
        email: identifier.includes('@') ? identifier : '',
      }
    case 'anonymous':
    case 'refresh':
      return {}
    default:
      return { email: identifier }
  }
}

/**
 * What Try opens with when another page sends someone to it ("Edit and run
 * again", the user's "Sign in for real…"): taken once by the panel.
 */
export const useTryDraft = create<{ fields: Partial<TryFields> | undefined }>(() => ({
  fields: undefined,
}))

/** Hands Try its fields; the caller then opens `/auth/activity?panel=try&method=…`. */
export function tryWith(fields: Partial<TryFields>): void {
  useTryDraft.setState({ fields })
}

/** The fields handed over, once. */
export function takeTryDraft(): Partial<TryFields> | undefined {
  const fields = useTryDraft.getState().fields
  if (fields) useTryDraft.setState({ fields: undefined })
  return fields
}
