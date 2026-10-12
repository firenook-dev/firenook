import { describe, expect, it } from 'vitest'
import { cleanSeed, sampleUsers } from './sample-users'

const base = {
  count: 300,
  providers: ['password', 'phone', 'google.com', 'anonymous'] as const,
  variety: true,
  password: 'password-1',
  seed: 'abc1',
  now: Date.UTC(2026, 9, 12),
}

describe('sample users', () => {
  it('are the same for the same seed, and others for another', () => {
    expect(sampleUsers(base)).toEqual(sampleUsers(base))
    expect(sampleUsers({ ...base, seed: 'other' })).not.toEqual(sampleUsers(base))
  })

  it('carry sample- uids and sample.test emails, all different', () => {
    const users = sampleUsers(base)
    expect(users).toHaveLength(300)
    expect(users.every((user) => String(user.localId).startsWith('sample-abc1-'))).toBe(true)
    const emails = users.flatMap((user) => (typeof user.email === 'string' ? [user.email] : []))
    expect(emails.every((email) => email.endsWith('@sample.test'))).toBe(true)
    expect(new Set(emails).size).toBe(emails.length)
    const phones = users.flatMap((user) =>
      typeof user.phoneNumber === 'string' ? [user.phoneNumber] : [],
    )
    expect(new Set(phones).size).toBe(phones.length)
    expect(phones.every((phone) => /^\+[1-9]\d{1,14}$/.test(phone))).toBe(true)
  })

  it('mix the providers in equal shares', () => {
    const users = sampleUsers(base)
    const of = (provider: string) =>
      users.filter((user) =>
        provider === 'anonymous'
          ? user.providerUserInfo === undefined
          : (user.providerUserInfo as { providerId: string }[] | undefined)?.[0]?.providerId ===
            provider,
      ).length
    expect([of('password'), of('phone'), of('google.com'), of('anonymous')]).toEqual([
      75, 75, 75, 75,
    ])
  })

  it('keep claims well under the limit, and a password the emulator can read back', () => {
    const users = sampleUsers(base)
    for (const user of users)
      if (typeof user.customAttributes === 'string')
        expect(user.customAttributes.length).toBeLessThanOrEqual(1_000)
    const withPassword = users.find((user) => typeof user.passwordHash === 'string')
    expect(String(withPassword?.passwordHash)).toMatch(/^fakeHash:salt=.+:password=password-1$/)
    expect(users.some((user) => user.disabled === true)).toBe(true)
    expect(users.some((user) => Array.isArray(user.mfaInfo))).toBe(true)
    // The emulator refuses a second factor without a verified email.
    expect(
      users
        .filter((user) => Array.isArray(user.mfaInfo))
        .every((user) => user.emailVerified === true),
    ).toBe(true)
    expect(sampleUsers({ ...base, variety: false }).some((user) => user.disabled === true)).toBe(
      false,
    )
  })

  it('takes a seed as letters and digits only', () => {
    expect(cleanSeed('My Seed #7!')).toBe('myseed7')
  })
})
