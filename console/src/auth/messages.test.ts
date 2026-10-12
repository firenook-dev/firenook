import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthMessage } from '@/api/generated/auth/AuthMessage'
import type { AuthMessageKind } from '@/api/generated/auth/AuthMessageKind'
import { ACTION_PATH, consoleActionLink } from './links'
import {
  TOASTS_KEY,
  actionBlocked,
  applyCode,
  deliveryText,
  messageAction,
  messageJson,
  openHref,
  primaryValue,
  readToastsOn,
  resetPassword,
  statusChip,
  toastText,
  writeToastsOn,
} from './messages'

function message(extra: Partial<AuthMessage> = {}): AuthMessage {
  return {
    id: 4,
    at: '2026-10-12T10:00:00.000Z',
    tenant: null,
    kind: 'passwordReset',
    channel: 'email',
    to: 'ada@example.test',
    newEmail: null,
    uid: 'u_ada',
    code: 'k3Jm7Q',
    link: 'http://127.0.0.1:9099/emulator/action?mode=resetPassword&lang=en&oobCode=k3Jm7Q&apiKey=fake-api-key',
    continueUrl: null,
    delivery: 'sent',
    origin: null,
    used: false,
    usedAt: null,
    activity: 12,
    usedBy: null,
    text: 'To reset the password for ada@example.test, follow this link: …',
    ...extra,
  }
}

const SMS = message({
  kind: 'smsSignIn',
  channel: 'sms',
  to: '+15550100',
  code: '482913',
  link: null,
  uid: null,
})

describe('an email link opened from the console', () => {
  const modes = ['resetPassword', 'verifyEmail', 'signIn', 'verifyAndChangeEmail', 'recoverEmail']

  it('keeps the query and swaps the origin and path for the console mount, for every mode', () => {
    for (const mode of modes) {
      const raw = `http://127.0.0.1:9099/emulator/action?mode=${mode}&lang=en&oobCode=abc&apiKey=fake-api-key`
      const opened = consoleActionLink(raw, 'https://console.example')
      expect(opened).toBe(
        `https://console.example${ACTION_PATH}?mode=${mode}&lang=en&oobCode=abc&apiKey=fake-api-key`,
      )
    }
  })

  it('keeps a tenant and a continue URL as they were encoded', () => {
    const raw =
      'http://10.0.0.5:9099/emulator/action?mode=signIn&lang=en&oobCode=x&apiKey=k&tenantId=acme&continueUrl=https%3A%2F%2Fapp.example%2Ffinish%3Fa%3D1'
    const opened = new URL(consoleActionLink(raw, 'http://127.0.0.1:4000'))
    expect(opened.origin).toBe('http://127.0.0.1:4000')
    expect(opened.pathname).toBe(ACTION_PATH)
    expect(opened.searchParams.get('tenantId')).toBe('acme')
    expect(opened.searchParams.get('continueUrl')).toBe('https://app.example/finish?a=1')
  })

  it('is what Open link opens, and nothing for an SMS code', () => {
    expect(openHref(message())).toBe(consoleActionLink(message().link ?? ''))
    expect(openHref(SMS)).toBeUndefined()
  })
})

describe('what each kind of message stands for', () => {
  it('has one action per kind', () => {
    const actions: Record<AuthMessageKind, [string, string]> = {
      verifyEmail: ['apply', 'Verify now'],
      passwordReset: ['reset', 'Set a new password'],
      emailSignIn: ['open', 'Open in app'],
      verifyAndChangeEmail: ['apply', 'Apply'],
      recoverEmail: ['apply', 'Revert the email'],
      smsSignIn: ['copy', 'Copy code'],
      smsMfaEnrollment: ['copy', 'Copy code'],
      smsMfaSignIn: ['copy', 'Copy code'],
    }
    for (const [kind, [action, label]] of Object.entries(actions)) {
      const found = messageAction({ kind: kind as AuthMessageKind })
      expect([found.kind, found.label]).toEqual([action, label])
    }
  })

  it('copies the code of an SMS and the link of an email (`c`), and the whole message (Shift+C)', () => {
    expect(primaryValue(SMS)).toBe('482913')
    expect(primaryValue(message())).toBe(message().link)
    expect(primaryValue(message({ link: null }))).toBe('k3Jm7Q')
    expect(JSON.parse(messageJson(SMS))).toEqual(SMS)
  })

  it('says what became of it, and nothing while it waits', () => {
    expect(statusChip(message())).toBeUndefined()
    expect(statusChip(message({ used: true }))).toBe('used')
    expect(statusChip(message({ delivery: 'returned' }))).toBe('returned')
    expect(statusChip(message({ delivery: 'restored' }))).toBe('saved state')
    expect(deliveryText(message({ delivery: 'returned' }))).toContain('nothing logged')
  })

  it('cannot be acted on for another project, or once used', () => {
    expect(actionBlocked('demo-a', 'demo-a', message())).toBeUndefined()
    expect(actionBlocked('', 'demo-a', message())).toBeUndefined()
    expect(actionBlocked('demo-other', 'demo-a', message())).toContain('demo-a')
    expect(actionBlocked('demo-a', 'demo-a', message({ used: true }))).toContain('works once')
  })

  it('toasts in the words the developer looks for', () => {
    expect(toastText(SMS).title).toBe('SMS code for +15550100: 482913')
    expect(toastText(message()).title).toBe('Password reset link for ada@example.test')
    expect(
      toastText(message({ kind: 'verifyAndChangeEmail', newEmail: 'new@example.test' }))
        .description,
    ).toBe('New email: new@example.test')
  })
})

/** Answers every request with `{}` and call id 31, and remembers what was sent. */
function capture() {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-firenook-activity': '31' },
      }),
    )
  })
  return calls
}

describe('the actions, as the app’s SDK sends them', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('apply a code with accounts:update as a client, in the message’s tenant', async () => {
    const calls = capture()
    const answer = await applyCode(message({ kind: 'verifyEmail', tenant: 'acme' }))
    expect(answer.activity).toBe(31)
    const [call] = calls
    expect(call?.url).toBe(
      '/console/api/v1/auth/identitytoolkit.googleapis.com/v1/accounts:update?key=fake-api-key',
    )
    expect(JSON.parse(String(call?.init.body))).toEqual({ oobCode: 'k3Jm7Q', tenantId: 'acme' })
    const headers = new Headers(call?.init.headers)
    expect(headers.get('x-firenook-console')).toBe('write')
    expect(headers.get('authorization')).toBeNull()
  })

  it('set a new password with accounts:resetPassword', async () => {
    const calls = capture()
    await resetPassword(message(), 'password-2')
    const [call] = calls
    expect(call?.url).toContain('/accounts:resetPassword?key=fake-api-key')
    expect(JSON.parse(String(call?.init.body))).toEqual({
      oobCode: 'k3Jm7Q',
      newPassword: 'password-2',
    })
  })
})

describe('the toasts switch', () => {
  afterEach(() => localStorage.removeItem(TOASTS_KEY))

  it('is on unless turned off, and remembered', () => {
    expect(readToastsOn()).toBe(true)
    writeToastsOn(false)
    expect(localStorage.getItem(TOASTS_KEY)).toBe('off')
    expect(readToastsOn()).toBe(false)
    writeToastsOn(true)
    expect(readToastsOn()).toBe(true)
  })
})
