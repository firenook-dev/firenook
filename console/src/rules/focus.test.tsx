import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEditorFocus } from './focus'
import { useOverlay } from './overlay'

afterEach(() => {
  act(() => useOverlay.setState({ overlay: undefined }))
  vi.useRealTimers()
})

describe('where a rules editor looks', () => {
  it('reveals and marks a link’s line once the rules are there, then lets the address forget it', () => {
    const onLineShown = vi.fn()
    const { result, rerender } = renderHook(
      ({ loaded, line }: { loaded: boolean; line: number | undefined }) =>
        useEditorFocus({ source: 'a\nb\nc', loaded, line, onLineShown }),
      { initialProps: { loaded: false, line: 2 as number | undefined } },
    )
    // Not before the text is there: a line of an empty editor is line 1.
    expect(result.current.reveal).toBeUndefined()
    expect(onLineShown).not.toHaveBeenCalled()
    rerender({ loaded: true, line: 2 })
    expect(result.current.reveal?.line).toBe(2)
    expect(result.current.lineMarks).toEqual([{ line: 2, tone: 'focus' }])
    expect(onLineShown).toHaveBeenCalledTimes(1)
    // The page dropped the param; the mark stays until something newer.
    rerender({ loaded: true, line: undefined })
    expect(result.current.lineMarks).toEqual([{ line: 2, tone: 'focus' }])
    expect(onLineShown).toHaveBeenCalledTimes(1)
  })

  it('lets a later click or a panel’s overlay take over from the mark', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { result } = renderHook(() =>
      useEditorFocus({ source: 'rules', loaded: true, line: 3, onLineShown: () => {} }),
    )
    expect(result.current.lineMarks).toEqual([{ line: 3, tone: 'focus' }])
    vi.setSystemTime(2_000)
    act(() => result.current.setReveal(1))
    expect(result.current.reveal?.line).toBe(1)
    expect(result.current.lineMarks).toBeUndefined()
    vi.setSystemTime(3_000)
    act(() =>
      useOverlay.getState().show({
        owner: 'decision',
        source: 'rules',
        lineMarks: [{ line: 4, tone: 'deny' }],
        values: [],
        reveal: 4,
      }),
    )
    expect(result.current.reveal?.line).toBe(4)
    expect(result.current.lineMarks).toEqual([{ line: 4, tone: 'deny' }])
    expect(result.current.at).toBe(4)
  })

  it('draws an overlay only over the text it is about', () => {
    const { result } = renderHook(() =>
      useEditorFocus({ source: 'the draft', loaded: true, line: undefined, onLineShown: () => {} }),
    )
    act(() =>
      useOverlay.getState().show({
        owner: 'playground',
        source: 'the rules in force',
        lineMarks: [{ line: 1, tone: 'allow' }],
        values: [],
        reveal: 1,
      }),
    )
    expect(result.current.shown).toBeUndefined()
    expect(result.current.reveal).toBeUndefined()
    expect(result.current.lineMarks).toBeUndefined()
  })
})
