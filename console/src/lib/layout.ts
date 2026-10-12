// The shell's layout: whether the primary navigation is expanded (a
// collapsed one keeps its icons and slides the labels out on hover) and
// whether the section panel, the second column a section can fill beside
// its content, is on screen. Both choices are remembered per browser; what
// a section puts in the panel is ephemeral and comes from the section
// itself through `SectionPanel`.
//
// On a narrow window (below `xl`, where an inspector floats over the list)
// the panel steps aside while an inspector is open: the navigation, the
// panel and a 420 px inspector left the list about 140 px at 1024, one
// column of it. The person's choice is not touched — it comes back when
// the inspector closes — and pressing the toggle shows the panel anyway.

import { create } from 'zustand'

const NAV_KEY = 'firenook.console.nav'
const PANEL_KEY = 'firenook.console.panel'

interface LayoutState {
  /** Whether the navigation shows its labels; collapsed, it peeks on hover. */
  navOpen: boolean
  setNavOpen: (open: boolean) => void
  /** `[` flips it. */
  toggleNav: () => void
  /** Whether the section panel shows when a section provides one. */
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  /** The section on screen has a panel, named for tooltips and ⌘K. */
  panel: { present: boolean; label: string }
  setPanel: (panel: { present: boolean; label: string }) => void
  /** The shell's slot element the panel portals into. */
  slot: HTMLElement | null
  setSlot: (slot: HTMLElement | null) => void
  /** Inspectors open now (each `Inspector` counts itself while mounted). */
  inspectors: number
  /** Counts an open inspector; the function it returns takes it off again. */
  inspectorOpened: () => () => void
  /** The window is narrower than `NARROW_BELOW`. */
  narrow: boolean
  setNarrow: (narrow: boolean) => void
  /** The panel was asked for while it stood aside; it stays until the inspectors close. */
  panelOverride: boolean
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A browser that refuses storage starts from the defaults next time.
  }
}

/** Open unless the person closed it; an older stored mode counts as closed. */
function loadNavOpen(): boolean {
  const stored = read(NAV_KEY)
  return stored !== 'closed' && stored !== 'collapsed' && stored !== 'hover'
}

/** Below this width an inspector floats over the list: Tailwind's `xl`, px. */
export const NARROW_BELOW = 1280

/** Whether the panel is on screen: the person's choice, unless it stands aside for an inspector. */
export function panelShown(
  state: Pick<LayoutState, 'panelOpen' | 'inspectors' | 'narrow' | 'panelOverride'>,
): boolean {
  return state.panelOpen && !(state.inspectors > 0 && state.narrow && !state.panelOverride)
}

export const useLayout = create<LayoutState>((set) => ({
  navOpen: loadNavOpen(),
  setNavOpen: (navOpen) => {
    write(NAV_KEY, navOpen ? 'open' : 'closed')
    set({ navOpen })
  },
  toggleNav: () =>
    set((state) => {
      write(NAV_KEY, state.navOpen ? 'closed' : 'open')
      return { navOpen: !state.navOpen }
    }),
  panelOpen: read(PANEL_KEY) !== 'closed',
  setPanelOpen: (panelOpen) => {
    write(PANEL_KEY, panelOpen ? 'open' : 'closed')
    set({ panelOpen, panelOverride: panelOpen })
  },
  // What the person sees flips: a panel standing aside for an inspector is
  // shown (their choice was already open), a shown one is closed.
  togglePanel: () =>
    set((state) => {
      if (panelShown(state)) {
        write(PANEL_KEY, 'closed')
        return { panelOpen: false, panelOverride: false }
      }
      write(PANEL_KEY, 'open')
      return { panelOpen: true, panelOverride: true }
    }),
  panel: { present: false, label: '' },
  setPanel: (panel) => set({ panel }),
  slot: null,
  setSlot: (slot) => set({ slot }),
  inspectors: 0,
  inspectorOpened: () => {
    set((state) => ({ inspectors: state.inspectors + 1 }))
    let released = false
    return () => {
      if (released) return
      released = true
      set((state) => {
        const inspectors = Math.max(0, state.inspectors - 1)
        return inspectors === 0 ? { inspectors, panelOverride: false } : { inspectors }
      })
    }
  },
  narrow: false,
  setNarrow: (narrow) => set({ narrow }),
  panelOverride: false,
}))
