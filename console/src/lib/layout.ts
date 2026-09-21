// The shell's layout: whether the primary navigation is expanded (a
// collapsed one keeps its icons and slides the labels out on hover) and
// whether the section panel, the second column a section can fill beside
// its content, is on screen. Both choices are remembered per browser; what
// a section puts in the panel is ephemeral and comes from the section
// itself through `SectionPanel`.

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
    set({ panelOpen })
  },
  togglePanel: () =>
    set((state) => {
      write(PANEL_KEY, state.panelOpen ? 'closed' : 'open')
      return { panelOpen: !state.panelOpen }
    }),
  panel: { present: false, label: '' },
  setPanel: (panel) => set({ panel }),
  slot: null,
  setSlot: (slot) => set({ slot }),
}))
