import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RecentEntry, createRecents, withRecent } from './recents'

// An entry the way Authentication keeps one: two fields say which user,
// a third (the label) can change.
interface User extends RecentEntry {
  tenant: string
  uid: string
  label: string
}

function isUser(value: unknown): value is User {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.tenant === 'string' &&
    typeof item.uid === 'string' &&
    typeof item.label === 'string' &&
    typeof item.at === 'number'
  )
}

const options = {
  limit: 3,
  isEntry: isUser,
  same: (a: Omit<User, 'at'>, b: Omit<User, 'at'>) => a.tenant === b.tenant && a.uid === b.uid,
}
const useUsers = createRecents<User>(options)
const KEY = 'firenook.console.test.recents.demo'

afterEach(() => {
  vi.restoreAllMocks()
  useUsers.setState({ key: '', items: [] })
  localStorage.clear()
})

const ada = { tenant: '', uid: 'u1', label: 'ada@example.test' }
const bob = { tenant: '', uid: 'u2', label: 'bob@example.test' }

describe('a recents store', () => {
  it('keeps the newest first, each once, up to its limit', () => {
    let items = withRecent<User>([], ada, 1, options)
    items = withRecent(items, bob, 2, options)
    items = withRecent(items, { tenant: 't', uid: 'u1', label: 'x' }, 3, options)
    items = withRecent(items, { tenant: '', uid: 'u3', label: 'c' }, 4, options)
    expect(items.map((item) => [item.tenant, item.uid])).toEqual([
      ['', 'u3'],
      ['t', 'u1'],
      ['', 'u2'],
    ])
    items = withRecent(items, { ...bob, label: 'bob' }, 5, options)
    expect(items.map((item) => [item.uid, item.label, item.at])).toEqual([
      ['u2', 'bob', 5],
      ['u3', 'c', 4],
      ['u1', 'x', 3],
    ])
  })

  it('remembers the list under its key, and reads only what is an entry', () => {
    localStorage.setItem(KEY, JSON.stringify([{ ...ada, at: 1 }, { uid: 3 }, 'nonsense']))
    useUsers.getState().load(KEY)
    expect(useUsers.getState().items).toEqual([{ ...ada, at: 1 }])
    useUsers.getState().record(bob)
    useUsers.setState({ key: '', items: [] })
    useUsers.getState().load(KEY)
    expect(useUsers.getState().items.map((item) => item.uid)).toEqual(['u2', 'u1'])
  })

  it('writes nothing for the entry that already leads unchanged, and records nothing before a key', () => {
    useUsers.getState().record(ada)
    expect(useUsers.getState().items).toEqual([])
    useUsers.getState().load(KEY)
    useUsers.getState().record(ada)
    const write = vi.spyOn(localStorage, 'setItem')
    useUsers.getState().record(ada)
    expect(write).not.toHaveBeenCalled()
    useUsers.getState().record({ ...ada, label: 'Ada' })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('forgets what no longer exists', () => {
    useUsers.getState().load(KEY)
    useUsers.getState().record(ada)
    useUsers.getState().record(bob)
    useUsers.getState().forget((item) => item.uid === 'u1')
    expect(useUsers.getState().items.map((item) => item.uid)).toEqual(['u2'])
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toHaveLength(1)
  })

  it('works for the page alone when storage refuses', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    useUsers.getState().load(KEY)
    useUsers.getState().record(ada)
    expect(useUsers.getState().items.map((item) => item.uid)).toEqual(['u1'])
  })
})
