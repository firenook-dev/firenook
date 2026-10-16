import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { usePaletteProviders } from '@/lib/palette'
import { CONNECT_PALETTE, useConnectPalette } from './palette'

function provider() {
  const found = usePaletteProviders.getState().providers[CONNECT_PALETTE]
  if (!found) throw new Error('Connect registered no provider')
  return found
}

const titles = (query: string) =>
  provider()(query).flatMap((group) => group.items.map((item) => item.title))

describe('Connect in ⌘K', () => {
  it('waits for a query, and leaves when the bar does', () => {
    const view = renderHook(() => useConnectPalette({ snippet: () => '' }))
    expect(titles('')).toEqual([])
    view.unmount()
    expect(usePaletteProviders.getState().providers[CONNECT_PALETTE]).toBeUndefined()
  })

  it('copies each platform’s snippet once something is typed', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderHook(() => useConnectPalette({ snippet: (param) => `snippet for ${param}` }))
    expect(titles('flutter')).toEqual(['Copy the Flutter snippet'])
    expect(titles('connect')).toEqual(expect.not.arrayContaining(['Connect with Web']))
    const [group] = provider()('copy python')
    expect(group?.label).toBe('Connect')
    group?.items[0]?.run()
    expect(writeText).toHaveBeenCalledWith('snippet for python')
    vi.unstubAllGlobals()
  })
})
