// What the Inbox does with a code or a link the emulator created: how each
// kind reads, the one action it stands for, and how that action is taken —
// through the same client endpoints the app's SDK calls, as a client of the
// emulator's own project, so it behaves exactly as tapping the email would
// (and Activity records it as the console's own edit).
//
// A link is opened through the console's origin (`consoleActionLink` in
// `links.ts`), never the Auth port, which a browser behind a proxy or on
// another machine may not reach; "Copy link" copies it as generated, for a
// device or a simulator.

import { create } from 'zustand'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import type { AuthMessageKind } from '@/api/generated/auth/AuthMessageKind'
import { type EmulatorAnswer, callAuthEmulator, toolkitPath } from './api'
import { MESSAGE_KIND_LABELS } from './fields'
import { consoleActionLink } from './links'

/** What a message is for, and what the console can do with it in one step. */
export type MessageAction =
  /** `accounts:update { oobCode }`: verify the email, apply the change, revert it. */
  | { kind: 'apply'; label: string; done: string }
  /** `accounts:resetPassword { oobCode, newPassword }`. */
  | { kind: 'reset'; label: string }
  /** The link itself: a sign-in link lands on the app's `continueUrl` with the code. */
  | { kind: 'open'; label: string }
  /** An SMS code is typed into the app: the console copies it. */
  | { kind: 'copy'; label: string }

const ACTIONS: Readonly<Record<AuthMessageKind, MessageAction>> = {
  verifyEmail: { kind: 'apply', label: 'Verify now', done: 'The email is verified.' },
  passwordReset: { kind: 'reset', label: 'Set a new password' },
  emailSignIn: { kind: 'open', label: 'Open in app' },
  verifyAndChangeEmail: { kind: 'apply', label: 'Apply', done: 'The email is changed.' },
  recoverEmail: { kind: 'apply', label: 'Revert the email', done: 'The email is reverted.' },
  smsSignIn: { kind: 'copy', label: 'Copy code' },
  smsMfaEnrollment: { kind: 'copy', label: 'Copy code' },
  smsMfaSignIn: { kind: 'copy', label: 'Copy code' },
}

/** The one action a message stands for (the reader's main button, `a` on the row). */
export function messageAction(message: Pick<AuthMessage, 'kind'>): MessageAction {
  return ACTIONS[message.kind]
}

export function isSms(message: Pick<AuthMessage, 'channel'>): boolean {
  return message.channel === 'sms'
}

/** `c` on a row: the code an SMS carries, else the link as generated (else the code). */
export function primaryValue(message: Pick<AuthMessage, 'channel' | 'code' | 'link'>): string {
  if (isSms(message)) return message.code
  return message.link ?? message.code
}

/** `Shift+C`: the message as the engine describes it. */
export function messageJson(message: AuthMessage): string {
  return JSON.stringify(message, null, 2)
}

/** The row's words: "Password reset", "SMS sign-in code". */
export function messageLabel(message: Pick<AuthMessage, 'kind'>): string {
  return MESSAGE_KIND_LABELS[message.kind]
}

/** How the message reached anyone, as the reader's meta says it. */
export function deliveryText(message: Pick<AuthMessage, 'delivery'>): string {
  if (message.delivery === 'returned') return 'returned to the caller, nothing logged'
  if (message.delivery === 'restored') return 'from saved state'
  return 'sent, the emulator logged it'
}

/** The quiet chip a row carries: used, returned or from saved state; unused says nothing. */
export function statusChip(
  message: Pick<AuthMessage, 'used' | 'delivery'>,
): 'used' | 'returned' | 'saved state' | undefined {
  if (message.used) return 'used'
  if (message.delivery === 'returned') return 'returned'
  if (message.delivery === 'restored') return 'saved state'
  return undefined
}

/** Where "Open link" goes: the console mount's action page, with the link's query. */
export function openHref(message: Pick<AuthMessage, 'link'>): string | undefined {
  return message.link ? consoleActionLink(message.link) : undefined
}

/**
 * Why the console cannot take a message's action for `project`, or nothing
 * when it can. The emulator applies codes to its own project only (its
 * action page and client endpoints name no other), so a code another
 * project's app asked for is shown, never used from here.
 */
export function actionBlocked(
  project: string,
  configured: string | undefined,
  message: Pick<AuthMessage, 'used'>,
): string | undefined {
  if (configured !== undefined && project !== '' && project !== configured)
    return `The emulator applies codes to its own project, ${configured}; this one belongs to ${project}.`
  if (message.used) return 'This code was used; a code works once.'
  return undefined
}

/** The body a client call carries for a message of a tenant. */
function scoped(message: Pick<AuthMessage, 'tenant'>, body: Record<string, unknown>) {
  return message.tenant ? { ...body, tenantId: message.tenant } : body
}

/**
 * "Verify now", "Apply", "Revert the email": `accounts:update { oobCode }`
 * as the app's SDK sends it (`applyActionCode`).
 */
export function applyCode(
  message: Pick<AuthMessage, 'code' | 'tenant'>,
): Promise<EmulatorAnswer<unknown>> {
  return callAuthEmulator({
    method: 'POST',
    path: toolkitPath('accounts:update'),
    body: scoped(message, { oobCode: message.code }),
    as: 'client',
    origin: 'write',
  })
}

/** The shortest password the emulator accepts. */
export const PASSWORD_MIN = 6

/** "Set a new password": `accounts:resetPassword { oobCode, newPassword }` (`confirmPasswordReset`). */
export function resetPassword(
  message: Pick<AuthMessage, 'code' | 'tenant'>,
  newPassword: string,
): Promise<EmulatorAnswer<unknown>> {
  return callAuthEmulator({
    method: 'POST',
    path: toolkitPath('accounts:resetPassword'),
    body: scoped(message, { oobCode: message.code, newPassword }),
    as: 'client',
    origin: 'write',
  })
}

// ------------------------------------------------------------------ toasts

/** Where the toasts switch is kept, per browser. */
export const TOASTS_KEY = 'firenook.console.auth.toasts'

/** Whether toasts for new codes and links are on (the default), read safely. */
export function readToastsOn(): boolean {
  try {
    return localStorage.getItem(TOASTS_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Remembers the switch; a browser that refuses storage keeps it for this tab only. */
export function writeToastsOn(on: boolean): void {
  try {
    if (on) localStorage.removeItem(TOASTS_KEY)
    else localStorage.setItem(TOASTS_KEY, 'off')
  } catch {
    // Kept in memory by the caller.
  }
}

/**
 * The switch, shared by the Inbox's toolbar and the beacon in every tab:
 * another tab turning it off turns it off here too.
 */
export const useToastsOn = create<{ on: boolean; set: (on: boolean) => void }>((set) => ({
  on: readToastsOn(),
  set: (on) => {
    writeToastsOn(on)
    set({ on })
  },
}))

if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === TOASTS_KEY || event.key === null) useToastsOn.setState({ on: readToastsOn() })
  })

/** A toast's words for a new message (the beacon's), and what it offers. */
export function toastText(message: AuthMessage): {
  title: string
  description: string | undefined
} {
  if (isSms(message))
    return {
      title: `SMS code for ${message.to}: ${message.code}`,
      description: messageLabel(message),
    }
  const what = messageLabel(message)
  return {
    title: `${what} link for ${message.to}`,
    description: message.newEmail ? `New email: ${message.newEmail}` : undefined,
  }
}
