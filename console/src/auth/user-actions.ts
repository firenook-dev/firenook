// What a developer does to one account from the console — from a row's
// menu, the inspector or ⌘K — written once. Every change goes through the
// official API, as the Admin SDK or the app sends it (`callAuthEmulator`),
// so it behaves exactly as it would from code and Activity records it as
// the console's own (`write`). A code or link the console asks for lands in
// the Inbox like any other; its toast opens it there by the call's id, so
// it is that call's message whatever else arrives meanwhile.

import type { SectionLink } from '@/lib/services'
import { copyToClipboard } from '@/lib/copy'
import { toast } from '@/lib/toasts'
import {
  AuthEmulatorError,
  callAuthEmulator,
  getMessagesOfCall,
  mintToken,
  toolkitPath,
} from './api'
import { messageLink } from './links'

/** One account, as every action names it. */
export interface UserTarget {
  project: string
  /** The tenant id; absent for the project's own users. */
  tenant: string | undefined
  uid: string
}

/** The account's scope in an Admin SDK path. */
function scopeOf(target: UserTarget) {
  return { project: target.project, tenant: target.tenant }
}

/** An emulator refusal in words: its code, and the emulator's own sentence when it has one. */
export function refusal(error: unknown): string {
  if (error instanceof AuthEmulatorError) {
    const detail = error.message.split(' : ').slice(1).join(' : ').trim()
    return detail ? `${error.code}: ${detail}` : error.code
  }
  return error instanceof Error ? error.message : String(error)
}

/** `accounts:update { localId, disableUser }` as the Admin SDK's `updateUser({ disabled })`. */
export async function setUserDisabled(target: UserTarget, disabled: boolean): Promise<void> {
  await callAuthEmulator({
    method: 'POST',
    path: toolkitPath('accounts:update', scopeOf(target)),
    body: { localId: target.uid, disableUser: disabled },
    as: 'admin',
    origin: 'write',
  })
}

/** `accounts:delete { localId }` as `deleteUser`: `user.delete` triggers run for it. */
export async function deleteUser(target: UserTarget): Promise<void> {
  await callAuthEmulator({
    method: 'POST',
    path: toolkitPath('accounts:delete', scopeOf(target)),
    body: { localId: target.uid },
    as: 'admin',
    origin: 'write',
  })
}

/**
 * `accounts:sendOobCode { requestType: PASSWORD_RESET, email }` as the
 * app's `sendPasswordResetEmail` sends it, through the mount with the API
 * key. Answers the call's Activity id.
 */
export async function sendPasswordReset(
  target: Pick<UserTarget, 'tenant'>,
  email: string,
): Promise<number | undefined> {
  const answer = await callAuthEmulator({
    method: 'POST',
    path: toolkitPath('accounts:sendOobCode'),
    body: {
      requestType: 'PASSWORD_RESET',
      email,
      ...(target.tenant ? { tenantId: target.tenant } : {}),
    },
    as: 'client',
    origin: 'write',
  })
  return answer.activity
}

/** The message a console call created, as the Inbox opens it; `undefined` when it sent none. */
export async function sentMessageLink(
  project: string,
  activity: number,
): Promise<SectionLink | undefined> {
  const page = await getMessagesOfCall(project, activity)
  const message = page.items[0]
  return message ? messageLink(message.id) : undefined
}

/**
 * Says a code or link was sent, with "Open in inbox" leading to exactly the
 * message the call created.
 */
export function announceSent(options: {
  project: string
  activity: number | undefined
  title: string
  description?: string | undefined
  navigate: (link: SectionLink) => void
}): void {
  const { project, activity } = options
  toast({
    key: activity === undefined ? `auth.sent.${options.title}` : `auth.sent.${activity}`,
    title: options.title,
    description: options.description,
    tone: 'success',
    ...(activity === undefined
      ? {}
      : {
          action: {
            label: 'Open in inbox',
            run: () =>
              void sentMessageLink(project, activity).then(
                (link) => {
                  if (link) options.navigate(link)
                },
                () =>
                  toast({
                    key: `auth.sent.${activity}`,
                    title: 'The console could not find that message',
                    description: 'Open the Inbox to see every code and link.',
                    tone: 'warning',
                  }),
              ),
          },
        }),
  })
}

/**
 * Mints the ID token a sign-in of this user would produce (the account's
 * own provider and first second factor, nothing stored) and copies it.
 */
export async function copyIdToken(target: UserTarget, label: string): Promise<void> {
  try {
    const minted = await mintToken(target.project, {
      uid: target.uid,
      ...(target.tenant ? { tenant: target.tenant } : {}),
    })
    await copyToClipboard(minted.idToken, {
      what: `an ID token for ${label}`,
      refused: 'Allow clipboard access for this page, or copy it from the inspector.',
    })
  } catch (error) {
    toast({
      key: 'auth.copy',
      title: `The engine did not mint a token for ${label}`,
      description: refusal(error),
      tone: 'danger',
    })
  }
}

/** `accounts:update` with any body, as the Admin SDK sends it for one account. */
export async function updateUser(target: UserTarget, body: Record<string, unknown>): Promise<void> {
  await callAuthEmulator({
    method: 'POST',
    path: toolkitPath('accounts:update', scopeOf(target)),
    body: { ...body, localId: target.uid },
    as: 'admin',
    origin: 'write',
  })
}

/** A new password (`updateUser({ password })`); it moves `validSince`, as Firebase does. */
export function changePassword(target: UserTarget, password: string): Promise<void> {
  return updateUser(target, { password })
}

/**
 * `revokeRefreshTokens`: `validSince` becomes now, so ID tokens issued
 * before it fail `verifyIdToken(token, true)` and the emulator's own checks.
 */
export function revokeTokens(target: UserTarget): Promise<void> {
  return updateUser(target, { validSince: String(Math.floor(Date.now() / 1_000)) })
}

/** Unlinks one provider (`deleteProvider`), as `updateUser({ providersToUnlink })` does. */
export function unlinkProvider(target: UserTarget, providerId: string): Promise<void> {
  return updateUser(target, { deleteProvider: [providerId] })
}

/** What a linked provider says about the account. */
export interface LinkedProvider {
  providerId: string
  rawId: string
  email?: string | undefined
  displayName?: string | undefined
  photoUrl?: string | undefined
}

/** Links a provider (`linkProviderUserInfo`): the account then "has Google", as after a real link. */
export function linkProvider(target: UserTarget, provider: LinkedProvider): Promise<void> {
  const info: Record<string, string> = { providerId: provider.providerId, rawId: provider.rawId }
  if (provider.email) info.email = provider.email
  if (provider.displayName) info.displayName = provider.displayName
  if (provider.photoUrl) info.photoUrl = provider.photoUrl
  return updateUser(target, { linkProviderUserInfo: info })
}

/** One SMS second factor as the update sends it (an existing one keeps its id). */
export interface SmsFactor {
  enrollmentId?: string | undefined
  phoneNumber: string
  displayName?: string | null | undefined
  enrolledAt?: string | null | undefined
}

/** The account's second factors become exactly these (`mfa.enrollments`; none removes them all). */
export function setSmsFactors(target: UserTarget, factors: readonly SmsFactor[]): Promise<void> {
  return updateUser(target, {
    mfa: {
      enrollments: factors.map((factor) => ({
        ...(factor.enrollmentId ? { mfaEnrollmentId: factor.enrollmentId } : {}),
        phoneInfo: factor.phoneNumber,
        ...(factor.displayName ? { displayName: factor.displayName } : {}),
        ...(factor.enrolledAt ? { enrolledAt: factor.enrolledAt } : {}),
      })),
    },
  })
}

/**
 * `sendEmailVerification`: an ID token minted for the account (nothing
 * stored), then `accounts:sendOobCode { requestType: VERIFY_EMAIL,
 * idToken }` as the app's SDK sends it. Answers the call's Activity id.
 */
export async function sendVerificationEmail(target: UserTarget): Promise<number | undefined> {
  const minted = await mintToken(target.project, {
    uid: target.uid,
    ...(target.tenant ? { tenant: target.tenant } : {}),
  })
  const answer = await callAuthEmulator({
    method: 'POST',
    path: toolkitPath('accounts:sendOobCode'),
    body: {
      requestType: 'VERIFY_EMAIL',
      idToken: minted.idToken,
      ...(target.tenant ? { tenantId: target.tenant } : {}),
    },
    as: 'client',
    origin: 'write',
  })
  return answer.activity
}

/** `sendSignInLinkToEmail`: an email sign-in link that continues at `continueUrl`. */
export async function sendSignInLink(
  target: Pick<UserTarget, 'tenant'>,
  email: string,
  continueUrl: string,
): Promise<number | undefined> {
  const answer = await callAuthEmulator({
    method: 'POST',
    path: toolkitPath('accounts:sendOobCode'),
    body: {
      requestType: 'EMAIL_SIGNIN',
      email,
      continueUrl,
      canHandleCodeInApp: true,
      ...(target.tenant ? { tenantId: target.tenant } : {}),
    },
    as: 'client',
    origin: 'write',
  })
  return answer.activity
}

/** Where the last sign-in link of a tenant continued, kept in this browser. */
export function continueUrlKey(project: string, tenant: string | undefined): string {
  return `firenook.console.auth.continue-url.${project}.${tenant ?? ''}`
}
