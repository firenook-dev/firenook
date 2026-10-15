import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { usePaletteProviders } from '@/lib/palette'
import { OVERVIEW_PALETTE, useOverviewPalette } from './palette'

function provider() {
  const found = usePaletteProviders.getState().providers[OVERVIEW_PALETTE]
  if (!found) throw new Error('the overview registered no provider')
  return found
}

const titles = (query: string) =>
  provider()(query).flatMap((group) => group.items.map((item) => item.title))

describe('the overview in ⌘K', () => {
  it('offers one way into Connect while nothing is typed', () => {
    const connect = vi.fn()
    const view = renderHook(() => useOverviewPalette({ connect, snippet: () => '' }))
    expect(titles('')).toEqual(['Connect your app'])
    provider()('')[0]?.items[0]?.run()
    expect(connect).toHaveBeenCalledOnce()
    view.unmount()
    expect(usePaletteProviders.getState().providers[OVERVIEW_PALETTE]).toBeUndefined()
  })

  it('copies each platform’s snippet once something is typed', async () => {
    const connect = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderHook(() =>
      useOverviewPalette({
        connect,
        snippet: (param) => `snippet for ${param}`,
      }),
    )
    expect(titles('flutter')).toEqual(['Copy the Flutter snippet'])
    expect(titles('connect')).toEqual(expect.not.arrayContaining(['Connect with Web']))
    const [group] = provider()('copy python')
    group?.items[0]?.run()
    expect(writeText).toHaveBeenCalledWith('snippet for python')
    expect(connect).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
