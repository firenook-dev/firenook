import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GRID_MIN,
  INSPECTOR_MIN,
  clampWidth,
  defaultWidth,
  inspectorWidth,
  resetInspectorWidths,
  storageKeyFor,
  useInspectorWidth,
} from './inspector-width'

beforeEach(() => {
  localStorage.clear()
  resetInspectorWidths()
})
afterEach(() => vi.unstubAllGlobals())

describe('the inspector width', () => {
  it('clamps to the floor and leaves the list its share', () => {
    expect(clampWidth(100, 1600)).toBe(INSPECTOR_MIN)
    expect(clampWidth(500, 1600)).toBe(500)
    expect(clampWidth(1500, 1600)).toBe(1600 - GRID_MIN)
    // A window too small for both gives the panel its floor, not less.
    expect(clampWidth(500, 500)).toBe(INSPECTOR_MIN)
    expect(clampWidth(480.4, 1600)).toBe(480)
  })

  it('opens at a share of the window, floored on a laptop and capped on a wide display', () => {
    vi.stubGlobal('innerWidth', 1440)
    expect(defaultWidth()).toBe(420)
    vi.stubGlobal('innerWidth', 2557)
    expect(defaultWidth()).toBe(716)
    vi.stubGlobal('innerWidth', 4000)
    expect(defaultWidth()).toBe(760)
  })

  it('keeps Firestore’s storage key and gives every other inspector its own', () => {
    expect(storageKeyFor('firestore')).toBe('firenook.console.inspector-width')
    expect(storageKeyFor('auth.user')).toBe('firenook.console.inspector-width.auth.user')
  })

  it('reads what was remembered, per inspector', () => {
    localStorage.setItem('firenook.console.inspector-width', '512')
    localStorage.setItem('firenook.console.inspector-width.auth.user', '600')
    localStorage.setItem('firenook.console.inspector-width.logs.entry', '12')
    expect(inspectorWidth('firestore')).toBe(512)
    expect(inspectorWidth('auth.user')).toBe(600)
    // A width below the floor is not a width anyone dragged to.
    vi.stubGlobal('innerWidth', 1440)
    expect(inspectorWidth('logs.entry')).toBe(420)
  })

  it('moves during a drag and writes only when it settles; a reset goes home', () => {
    vi.stubGlobal('innerWidth', 1440)
    const { result } = renderHook(() => useInspectorWidth('auth.user'))
    const other = renderHook(() => useInspectorWidth('firestore'))
    act(() => result.current.setWidth(555))
    expect(result.current.width).toBe(555)
    expect(other.result.current.width).toBe(420)
    expect(localStorage.getItem('firenook.console.inspector-width.auth.user')).toBeNull()
    act(() => result.current.remember())
    expect(localStorage.getItem('firenook.console.inspector-width.auth.user')).toBe('555')
    act(() => result.current.reset())
    expect(result.current.width).toBe(420)
    expect(localStorage.getItem('firenook.console.inspector-width.auth.user')).toBe('420')
  })

  it('starts from the default when storage refuses', () => {
    vi.stubGlobal('innerWidth', 1440)
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    const { result } = renderHook(() => useInspectorWidth('auth.user'))
    expect(result.current.width).toBe(420)
    act(() => {
      result.current.setWidth(500)
      result.current.remember()
    })
    expect(result.current.width).toBe(500)
  })
})
