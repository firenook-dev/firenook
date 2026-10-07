import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { loadSubcollections } from './subcollections'

interface Asked {
  database: string
  paths: string[]
}

/** Answers every asked path with one collection named after it. */
function engine(): { calls: Asked[]; fetch: ReturnType<typeof vi.fn> } {
  const calls: Asked[] = []
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const asked = JSON.parse(String(init.body)) as Asked
    calls.push(asked)
    return new Response(
      JSON.stringify({
        database: asked.database,
        revision: 7,
        parents: asked.paths.map((path) => ({
          path,
          collections: [{ id: `under-${path || 'root'}`, documents: path.length }],
        })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  vi.stubGlobal('fetch', fetch)
  return { calls, fetch }
}

describe('asking the engine for subcollections', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('collects a whole screen of rows into one request', async () => {
    const { calls } = engine()
    const paths = Array.from({ length: 32 }, (_, index) => `users/u${index}`)
    const answers = await Promise.all(paths.map((path) => loadSubcollections('(default)', path)))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.paths).toEqual(paths)
    expect(calls[0]?.database).toBe('(default)')
    // Each row still gets its own answer, matched by path rather than order.
    expect(answers[5]?.[0]?.id).toBe('under-users/u5')
    expect(answers[31]?.[0]?.documents).toBe('users/u31'.length)
  })

  it('asks once for a path several rows want, and answers them all', async () => {
    const { calls } = engine()
    const answers = await Promise.all([
      loadSubcollections('(default)', 'users/u1'),
      loadSubcollections('(default)', 'users/u1'),
      loadSubcollections('(default)', 'users/u2'),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.paths).toEqual(['users/u1', 'users/u2'])
    expect(answers[0]).toEqual(answers[1])
    expect(answers[2]?.[0]?.id).toBe('under-users/u2')
  })

  it('keeps databases apart', async () => {
    const { calls } = engine()
    await Promise.all([
      loadSubcollections('(default)', 'users/u1'),
      loadSubcollections('analytics', 'users/u1'),
    ])
    expect(calls.map((call) => call.database).toSorted()).toEqual(['(default)', 'analytics'])
  })

  it('sends a full batch early instead of waiting for the tick', async () => {
    const { calls } = engine()
    const paths = Array.from({ length: 201 }, (_, index) => `users/u${index}`)
    await Promise.all(paths.map((path) => loadSubcollections('(default)', path)))
    expect(calls.map((call) => call.paths.length)).toEqual([200, 1])
  })

  it('fails every waiter with the engine’s own message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'not a document path: users' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const results = await Promise.allSettled([
      loadSubcollections('(default)', 'users'),
      loadSubcollections('(default)', 'users/u1'),
    ])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    for (const result of results) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ApiError)
      expect((result as PromiseRejectedResult).reason.message).toBe('not a document path: users')
    }
  })

  it('says so when the engine answers without a path it was asked for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ database: '(default)', revision: 1, parents: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    await expect(loadSubcollections('(default)', 'users/u1')).rejects.toThrow(
      'the engine did not answer for users/u1',
    )
  })
})
