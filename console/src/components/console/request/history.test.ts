import { describe, expect, it } from 'vitest'
import { HISTORY_LIMIT, createRequestHistory } from './history'
import type { ComposedRequest } from './types'

const request = (url: string, text = '{}'): ComposedRequest => ({
  method: 'POST',
  url,
  codeUrl: `http://127.0.0.1:5001${url}`,
  query: [],
  headers: [],
  body: { kind: 'json', text },
  identity: { kind: 'anonymous' },
})

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

describe("a composer's history", () => {
  it('keeps the newest first, one entry per distinct request, at most 25', () => {
    const storage = memoryStorage()
    const history = createRequestHistory(storage)
    for (let index = 0; index < 30; index += 1) history.push('demo.invoke', request(`/f${index}`))
    history.push('demo.invoke', request('/f29'))
    const entries = history.entries('demo.invoke')
    expect(entries).toHaveLength(HISTORY_LIMIT)
    expect(entries[0]?.url).toBe('/f29')
    expect(entries.filter((entry) => entry.url === '/f29')).toHaveLength(1)
    // Stored per slot, and read back by a new store (a reload).
    expect(storage.items.has('firenook.console.requests.demo.invoke')).toBe(true)
    expect(createRequestHistory(storage).entries('demo.invoke')[0]?.url).toBe('/f29')
    expect(createRequestHistory(storage).entries('other.invoke')).toEqual([])
  })

  it('stores a body over 64 KB as its size, not its text', () => {
    const history = createRequestHistory(memoryStorage())
    const large = 'x'.repeat(2.1 * 1024 * 1024)
    history.push('demo.invoke', request('/big', large))
    const [entry] = history.entries('demo.invoke')
    expect(entry?.body.text).toBe('')
    expect(entry?.bodyOmitted).toBe('2.10 MB')
    history.push('demo.invoke', request('/small', '{"a":1}'))
    const [small] = history.entries('demo.invoke')
    expect(small?.body.text).toBe('{"a":1}')
    expect(small?.bodyOmitted).toBeUndefined()
  })

  it('keeps working in memory when the browser refuses the write', () => {
    const history = createRequestHistory({
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError')
      },
      removeItem: () => {
        throw new DOMException('quota', 'QuotaExceededError')
      },
    })
    let heard = 0
    history.subscribe(() => {
      heard += 1
    })
    history.push('demo.invoke', request('/a'))
    history.push('demo.invoke', request('/b'))
    expect(history.entries('demo.invoke').map((entry) => entry.url)).toEqual(['/b', '/a'])
    history.clear('demo.invoke')
    expect(history.entries('demo.invoke')).toEqual([])
    expect(heard).toBe(3)
    // And with no storage at all.
    const none = createRequestHistory(undefined)
    none.push('demo.invoke', request('/c'))
    expect(none.entries('demo.invoke')).toHaveLength(1)
  })
})
