import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useCoveragePreference } from './toolbar'

afterEach(() => localStorage.clear())

describe('the coverage preference', () => {
  it('is off until asked for, then remembered for that page alone', () => {
    const firestore = renderHook(() => useCoveragePreference('firestore'))
    expect(firestore.result.current[0]).toBe(false)
    act(() => firestore.result.current[1](true))
    expect(firestore.result.current[0]).toBe(true)

    // A reload of the same page keeps it; the other rules page does not share it.
    expect(renderHook(() => useCoveragePreference('firestore')).result.current[0]).toBe(true)
    expect(renderHook(() => useCoveragePreference('storage')).result.current[0]).toBe(false)

    act(() => firestore.result.current[1](false))
    expect(renderHook(() => useCoveragePreference('firestore')).result.current[0]).toBe(false)
  })
})
