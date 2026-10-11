// The console's colour scheme: light, dark, or whatever the operating system
// says. Kumo carries a full set of dark tokens and theme.css redefines the
// Firenook accent for them; `data-mode` on the document is the attribute they
// key on. `index.html` declares `color-scheme: light dark`, so the browser
// paints its own scrollbars and form controls to match — without this they
// disagreed with the page.
//
// The choice is remembered per browser, and `system` keeps following the OS
// for as long as it is the choice, so a machine that darkens at sunset takes
// the console with it.

import { create } from 'zustand'

const KEY = 'firenook.console.theme'
const QUERY = '(prefers-color-scheme: dark)'

/** What the person picked. */
export type ThemeChoice = 'system' | 'light' | 'dark'
/** What the page actually paints; `system` resolves to one of these. */
export type ColorMode = 'light' | 'dark'

interface ThemeState {
  choice: ThemeChoice
  /** What `choice` resolves to right now. */
  mode: ColorMode
  setChoice: (choice: ThemeChoice) => void
}

/** The media query, when the environment has one (a test renderer may not). */
function media(): MediaQueryList | undefined {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : undefined
}

function load(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // A browser that refuses storage follows the system, like a new one.
  }
  return 'system'
}

function save(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    // The choice still applies to this page; it just is not remembered.
  }
}

/** What a choice paints; `system` asks the operating system. */
export function resolveTheme(choice: ThemeChoice): ColorMode {
  if (choice !== 'system') return choice
  return media()?.matches ? 'dark' : 'light'
}

function apply(mode: ColorMode): void {
  document.documentElement.setAttribute('data-mode', mode)
}

const initial = load()

export const useTheme = create<ThemeState>((set) => ({
  choice: initial,
  mode: resolveTheme(initial),
  setChoice: (choice) => {
    save(choice)
    const mode = resolveTheme(choice)
    apply(mode)
    set({ choice, mode })
  },
}))

/**
 * Paints the remembered choice and keeps following the operating system.
 * Called before the first render, so the page never flashes the wrong mode.
 */
export function startTheme(): void {
  apply(useTheme.getState().mode)
  // The system can change under an explicit choice too; recomputing from the
  // current choice is a no-op then, and correct the moment it becomes
  // `system` again.
  media()?.addEventListener('change', () => {
    const mode = resolveTheme(useTheme.getState().choice)
    apply(mode)
    useTheme.setState({ mode })
  })
}

/** How the picker and the palette name a choice. */
export function describeTheme(choice: ThemeChoice, mode: ColorMode): string {
  if (choice === 'system') return `match the system · ${mode} right now`
  return choice
}
