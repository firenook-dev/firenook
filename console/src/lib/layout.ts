// The shell's layout: how the primary navigation shows (expanded, collapsed
// to icons, or collapsed until hovered) and whether the section panel, the
// second column a section can fill beside its content, is on screen. Both
// choices are remembered per browser; what a section puts in the panel is
// ephemeral and comes from the section itself through `SectionPanel`.

import { create } from 'zustand'

export type NavMode = 'expanded' | 'collapsed' | 'hover'

export const NAV_MODES: ReadonlyArray<{ value: NavMode; label: string; hint: string }> = [
  { value: 'expanded', label: 'Expanded', hint: 'Icons and labels' },
  { value: 'collapsed', label: 'Collapsed', hint: 'Icons only, labels on hover' },
  { value: 'hover', label: 'Expand on hover', hint: 'Icons; the labels slide out over the page' },
]

const NAV_KEY = 'firenook.console.nav'
const PANEL_KEY = 'firenook.console.panel'

interface LayoutState {
  navMode: NavMode
  setNavMode: (mode: NavMode) => void
  /** `[` flips between expanded and collapsed; hover counts as collapsed. */
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

function loadNavMode(): NavMode {
  const stored = read(NAV_KEY)
  return stored === 'collapsed' || stored === 'hover' ? stored : 'expanded'
}

export const useLayout = create<LayoutState>((set) => ({
  navMode: loadNavMode(),
  setNavMode: (navMode) => {
    write(NAV_KEY, navMode)
    set({ navMode })
  },
  toggleNav: () =>
    set((state) => {
      const navMode: NavMode = state.navMode === 'expanded' ? 'collapsed' : 'expanded'
      write(NAV_KEY, navMode)
      return { navMode }
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
