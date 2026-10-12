import { describe, expect, it } from 'vitest'
import { rulesPageSearch } from './search'

const firestore = rulesPageSearch('db', {
  panel: ['decisions', 'playground', 'tests', 'collections'],
})
const storage = rulesPageSearch('bucket', {
  panel: ['decisions', 'playground', 'tests', 'folders'],
})

describe('the rules pages’ one search schema', () => {
  it('reads every shared param, and the scope under its own name', () => {
    expect(
      firestore.parse({
        db: 'shop',
        panel: 'collections',
        decision: 'r-42',
        path: 'users',
        uid: '',
        denied: true,
        method: 'list',
        flips: true,
        pick: true,
        line: 12,
      }),
    ).toEqual({
      db: 'shop',
      panel: 'collections',
      decision: 'r-42',
      path: 'users',
      uid: '',
      denied: true,
      method: 'list',
      flips: true,
      pick: true,
      line: 12,
    })
    expect(storage.parse({ bucket: 'demo-media', panel: 'folders', line: 6 })).toEqual({
      bucket: 'demo-media',
      panel: 'folders',
      line: 6,
    })
  })

  it('keeps each page to its own panels and scope', () => {
    expect(firestore.safeParse({ panel: 'folders' }).success).toBe(false)
    expect(storage.safeParse({ panel: 'collections' }).success).toBe(false)
    expect(storage.parse({ db: 'shop' })).toEqual({})
  })

  it('takes a line as a number from one, and a method from the five', () => {
    expect(firestore.safeParse({ line: 0 }).success).toBe(false)
    expect(firestore.safeParse({ line: 2.5 }).success).toBe(false)
    expect(firestore.safeParse({ method: 'write' }).success).toBe(false)
  })
})
