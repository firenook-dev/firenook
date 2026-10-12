import { describe, expect, it } from 'vitest'
import { sessionIdle, sessionOwner, sessionProgress } from './sessions'

describe('an unfinished upload', () => {
  it('says how much arrived', () => {
    expect(sessionProgress({ received: 48 * 1024 * 1024, total: 210 * 1024 * 1024 })).toBe(
      '48.0 MB of 210 MB',
    )
    expect(sessionProgress({ received: 1024, total: null })).toBe('1.0 KB received')
  })

  it('says how long it has been idle, and who started it', () => {
    const now = Date.parse('2026-10-12T12:00:00Z')
    expect(sessionIdle({ updatedAt: '2026-10-12T09:00:00Z', startedAt: null }, now)).toBe(
      'idle 3 h',
    )
    expect(sessionIdle({ updatedAt: null, startedAt: null }, now)).toBeUndefined()
    expect(sessionOwner({ uid: 'u1', admin: false })).toBe('u1')
    expect(sessionOwner({ uid: null, admin: true })).toBe('Admin')
    expect(sessionOwner({ uid: null, admin: false })).toBe('anonymous')
  })
})
