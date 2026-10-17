import { describe, expect, it } from 'vitest'
import { liveTrouble } from './live-badge'

const label = (...args: Parameters<typeof liveTrouble>) => liveTrouble(...args)?.label

describe('what the top bar says about the live channel', () => {
  it('says nothing while it is live, or before it first is', () => {
    expect(liveTrouble('live', false, false)).toBeUndefined()
    expect(liveTrouble('connecting', false, false)).toBeUndefined()
  })

  it('names each trouble, an updated engine first', () => {
    expect(label('reconnecting', false, false)).toBe('Reconnecting')
    expect(liveTrouble('reconnecting', false, false)?.pulse).toBe(true)
    expect(label('offline', false, false)).toBe('Engine stopped')
    expect(label('too-many', false, false)).toBe('Too many console tabs')
    expect(label('connecting', false, true)).toBe('Engine unreachable')
    expect(label('live', true, false)).toBe('Engine updated')
    expect(label('offline', true, false)).toBe('Engine updated')
  })
})
