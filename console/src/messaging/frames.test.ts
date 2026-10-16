import { describe, expect, it } from 'vitest'
import { createFrameLog } from './frames'

describe('the frames a re-read list catches up with', () => {
  it('answers the frames newer than a revision, oldest first, by scope', () => {
    const log = createFrameLog<{ revision: number; label: string }>()
    log.record('a', { revision: 3, label: 'three' })
    log.record('a', { revision: 5, label: 'five' })
    log.record('b', { revision: 9, label: 'other' })
    expect(log.newerThan('a', 3).map((frame) => frame.label)).toEqual(['five'])
    expect(log.newerThan('a', 0).map((frame) => frame.label)).toEqual(['three', 'five'])
    expect(log.newerThan('c', 0)).toEqual([])
  })

  it('keeps the newest few, none older than the age', () => {
    let now = 1_000
    const log = createFrameLog<{ revision: number }>({ limit: 2, maxAgeMs: 100, now: () => now })
    log.record('a', { revision: 1 })
    log.record('a', { revision: 2 })
    log.record('a', { revision: 3 })
    expect(log.newerThan('a', 0).map((frame) => frame.revision)).toEqual([2, 3])
    now += 101
    expect(log.newerThan('a', 0)).toEqual([])
  })

  it('forgets a scope, or everything', () => {
    const log = createFrameLog<{ revision: number }>()
    log.record('a', { revision: 1 })
    log.record('b', { revision: 1 })
    log.clear('a')
    expect(log.newerThan('a', 0)).toEqual([])
    expect(log.newerThan('b', 0)).toHaveLength(1)
    log.clear()
    expect(log.newerThan('b', 0)).toEqual([])
  })
})
