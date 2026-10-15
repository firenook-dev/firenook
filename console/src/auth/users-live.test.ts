import type { QueryKey } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { AuthUsersChanged } from '@/api/generated/auth/AuthUsersChanged'
import { FLASH_MS } from '@/components/kit'
import { createUsersLive } from './users-live'

function harness(open?: string) {
  const calls = {
    applied: [] as string[][],
    resets: 0,
    deleted: new Set<string>(),
    refreshed: [] as QueryKey[],
    stale: [] as QueryKey[],
  }
  const timers: { run: () => void; ms: number }[] = []
  const live = createUsersLive({
    applyKeys: (uids) => calls.applied.push([...uids]),
    reset: () => {
      calls.resets += 1
    },
    openUid: () => open,
    markDeleted: (uids, on) => {
      for (const uid of uids) {
        if (on) calls.deleted.add(uid)
        else calls.deleted.delete(uid)
      }
    },
    refresh: (key) => calls.refreshed.push(key),
    stale: (key) => calls.stale.push(key),
    keys: {
      claims: ['auth', 'p', 'claims', ''],
      user: (uid) => ['auth', 'p', 'user', '', uid],
      tenants: ['auth', 'p', 'tenant-picker'],
      summary: ['auth', 'p', 'summary'],
    },
    setTimer: (run, ms) => {
      const timer = { run, ms }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      const at = timers.indexOf(timer as { run: () => void; ms: number })
      if (at !== -1) timers.splice(at, 1)
    },
  })
  return { live, calls, timers }
}

const window = (changes: AuthUsersChanged['changes']): AuthUsersChanged => ({
  tenant: null,
  changes,
})

describe('the users window', () => {
  it('reads every created and updated row again at once, in one call', () => {
    const { live, calls } = harness()
    live.changed(
      window([
        { uid: 'a', change: 'created', fields: [] },
        { uid: 'b', change: 'updated', fields: ['displayName'] },
        { uid: 'a', change: 'updated', fields: ['lastLoginAt'] },
      ]),
    )
    expect(calls.applied).toEqual([['a', 'b']])
    expect(calls.refreshed).toEqual([])
    // Users came: the tenant counts the picker shows are stale.
    expect(calls.stale).toEqual([
      ['auth', 'p', 'tenant-picker'],
      ['auth', 'p', 'summary'],
    ])
  })

  it('draws a deleted row as deleted for FLASH_MS, then reads it again so it goes', () => {
    const { live, calls, timers } = harness()
    live.changed(
      window([
        { uid: 'gone', change: 'deleted', fields: [] },
        { uid: 'kept', change: 'updated', fields: ['disabled'] },
      ]),
    )
    expect(calls.applied).toEqual([['kept']])
    expect([...calls.deleted]).toEqual(['gone'])
    expect(timers).toHaveLength(1)
    expect(timers[0]?.ms).toBe(FLASH_MS)
    timers[0]?.run()
    expect(calls.applied).toEqual([['kept'], ['gone']])
    expect([...calls.deleted]).toEqual([])
  })

  it('reads the claim keys again only when some user’s claims changed', () => {
    const { live, calls } = harness()
    live.changed(window([{ uid: 'a', change: 'updated', fields: ['lastLoginAt', 'displayName'] }]))
    expect(calls.refreshed).toEqual([])
    live.changed(window([{ uid: 'a', change: 'updated', fields: ['customAttributes'] }]))
    expect(calls.refreshed).toEqual([['auth', 'p', 'claims', '']])
    // An update creates and deletes no one: the tenant counts stand.
    expect(calls.stale).toEqual([])
  })

  it('reads the open user again when the window names them, and only then', () => {
    const { live, calls } = harness('ada')
    live.changed(window([{ uid: 'grace', change: 'updated', fields: ['displayName'] }]))
    expect(calls.refreshed).toEqual([])
    live.changed(window([{ uid: 'ada', change: 'updated', fields: ['displayName'] }]))
    expect(calls.refreshed).toEqual([['auth', 'p', 'user', '', 'ada']])
  })

  it('starts the table again on cleared, reset or end, and drops pending deletes when disposed', () => {
    const { live, calls, timers } = harness('ada')
    live.restart()
    expect(calls.resets).toBe(1)
    expect(calls.refreshed).toEqual([
      ['auth', 'p', 'user', '', 'ada'],
      ['auth', 'p', 'claims', ''],
    ])
    live.changed(window([{ uid: 'x', change: 'deleted', fields: [] }]))
    expect(timers).toHaveLength(1)
    live.dispose()
    expect(timers).toHaveLength(0)
  })
})
