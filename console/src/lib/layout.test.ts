import { afterEach, describe, expect, it } from 'vitest'
import { panelShown, useLayout } from './layout'

afterEach(() => {
  useLayout.setState({ panelOpen: true, inspectors: 0, narrow: false, panelOverride: false })
})

describe('the section panel beside an inspector', () => {
  it('stands aside only while an inspector is open on a narrow window', () => {
    const base = { panelOpen: true, inspectors: 0, narrow: false, panelOverride: false }
    expect(panelShown(base)).toBe(true)
    expect(panelShown({ ...base, inspectors: 1 })).toBe(true)
    expect(panelShown({ ...base, narrow: true })).toBe(true)
    expect(panelShown({ ...base, inspectors: 1, narrow: true })).toBe(false)
    expect(panelShown({ ...base, inspectors: 1, narrow: true, panelOverride: true })).toBe(true)
    expect(panelShown({ ...base, panelOpen: false })).toBe(false)
  })

  it('comes back when the inspector closes, without touching the person’s choice', () => {
    useLayout.setState({ panelOpen: true, narrow: true })
    const release = useLayout.getState().inspectorOpened()
    expect(panelShown(useLayout.getState())).toBe(false)
    expect(useLayout.getState().panelOpen).toBe(true)
    release()
    release()
    expect(useLayout.getState().inspectors).toBe(0)
    expect(panelShown(useLayout.getState())).toBe(true)
  })

  it('shows on the toggle while it stands aside, and stands aside again for the next inspector', () => {
    useLayout.setState({ panelOpen: true, narrow: true })
    const release = useLayout.getState().inspectorOpened()
    useLayout.getState().togglePanel()
    expect(panelShown(useLayout.getState())).toBe(true)
    useLayout.getState().togglePanel()
    expect(useLayout.getState().panelOpen).toBe(false)
    useLayout.getState().togglePanel()
    expect(panelShown(useLayout.getState())).toBe(true)
    release()
    const again = useLayout.getState().inspectorOpened()
    expect(panelShown(useLayout.getState())).toBe(false)
    again()
  })
})
