import { afterEach, describe, expect, it } from 'vitest'
import { useLogsPrefs } from './prefs'

afterEach(() => localStorage.clear())

describe('Logs preferences', () => {
  it('remembers wrap and keep-across-restarts per browser', () => {
    useLogsPrefs.getState().setWrap(true)
    useLogsPrefs.getState().setKeepAcrossRestarts(true)
    expect(localStorage.getItem('firenook.console.logs.wrap')).toBe('true')
    expect(localStorage.getItem('firenook.console.logs.keep-across-restarts')).toBe('true')
    useLogsPrefs.getState().setWrap(false)
    expect(localStorage.getItem('firenook.console.logs.wrap')).toBeNull()
  })

  it('follows a change made in another tab', () => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'firenook.console.logs.wrap', newValue: 'true' }),
    )
    expect(useLogsPrefs.getState().wrap).toBe(true)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'firenook.console.logs.keep-across-restarts',
        newValue: null,
      }),
    )
    expect(useLogsPrefs.getState().keepAcrossRestarts).toBe(false)
  })
})
