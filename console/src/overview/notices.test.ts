import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { OverviewNotice } from '@/api/generated/observe/OverviewNotice'
import { createNoticeStore, noticeKey, useNotices, visibleNotices } from './notices'

/** A storage two "tabs" share, as tabs of one browser share localStorage. */
function sharedStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  }
}

const refusing = {
  getItem: () => {
    throw new Error('denied')
  },
  setItem: () => {
    throw new Error('denied')
  },
}

const notices: OverviewNotice[] = [
  { level: 'warn', code: 'publicHost', message: 'The engine listens on 0.0.0.0.' },
  { level: 'info', code: 'diagnosticsOff', message: 'Diagnostics are off.' },
]

describe('configuration notices', () => {
  it('are dismissed per code and per engine run, in localStorage', () => {
    const storage = sharedStorage()
    const store = createNoticeStore(storage)
    store.dismiss('publicHost', 'run-1')
    expect(storage.values.get(noticeKey('publicHost', 'run-1'))).toBe('1')
    expect(noticeKey('publicHost', 'run-1')).toBe('firenook.console.notice.publicHost.run-1')
    expect(visibleNotices(notices, 'run-1', store).map((notice) => notice.code)).toEqual([
      'diagnosticsOff',
    ])
    // A new engine run shows it again.
    expect(visibleNotices(notices, 'run-2', store)).toHaveLength(2)
  })

  it('are dismissed in every tab, which re-renders when another tab dismisses one', () => {
    const storage = sharedStorage()
    const events = new EventTarget()
    const mine = createNoticeStore(storage)
    const other = createNoticeStore(storage, events as unknown as Window)
    const { result } = renderHook(() => useNotices(notices, 'run-1', other))
    expect(result.current.visible).toHaveLength(2)
    act(() => {
      mine.dismiss('diagnosticsOff', 'run-1')
      events.dispatchEvent(
        new StorageEvent('storage', { key: noticeKey('diagnosticsOff', 'run-1') }),
      )
    })
    expect(result.current.visible.map((notice) => notice.code)).toEqual(['publicHost'])
  })

  it('are still shown when storage throws, and a dismissal lasts for the tab', () => {
    const store = createNoticeStore(refusing)
    const { result } = renderHook(() => useNotices(notices, 'run-1', store))
    expect(result.current.visible).toHaveLength(2)
    act(() => result.current.dismiss('publicHost'))
    expect(result.current.visible.map((notice) => notice.code)).toEqual(['diagnosticsOff'])
    expect(createNoticeStore(undefined).isDismissed('publicHost', 'run-1')).toBe(false)
  })
})
