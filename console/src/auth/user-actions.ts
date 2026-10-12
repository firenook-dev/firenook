// What a developer does to one account from the console — from a row's
// menu, the inspector or ⌘K — written once. Every change goes through the
// official API, as the Admin SDK or the app sends it (`callAuthEmulator`),
// so it behaves exactly as it would from code and Activity records it as
// the console's own (`write`). A code or link the console asks for lands in
// the Inbox like any other; its toast opens it there by the call's id, so
// it is that call's message whatever else arrives meanwhile.

import type { SectionLink } from '@/lib/services'
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

/** Writes text to the clipboard and says so (or why not). */
export async function copyToClipboard(text: string, what: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    toast({ key: 'auth.copy', title: `Copied ${what}`, tone: 'success' })
    return true
  } catch {
    toast({
      key: 'auth.copy',
      title: 'The browser did not let the console copy',
      description: 'Allow clipboard access for this page, or copy it from the inspector.',
      tone: 'warning',
    })
    return false
  }
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
    await copyToClipboard(minted.idToken, `an ID token for ${label}`)
  } catch (error) {
    toast({
      key: 'auth.copy',
      title: `The engine did not mint a token for ${label}`,
      description: refusal(error),
      tone: 'danger',
    })
  }
}
