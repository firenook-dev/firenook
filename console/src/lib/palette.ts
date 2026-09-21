// The ⌘K palette is one surface for the whole console. The shell contributes
// its sections; the page on screen contributes what it knows (Firestore adds
// collections, recent paths and its actions). A page registers a provider
// while mounted; the palette asks every provider for groups as you type.

import type { ReactNode } from 'react'
import { create } from 'zustand'

export interface PaletteItem {
  id: string
  title: string
  /** Shown before the title, for an item that lives under something. */
  breadcrumbs?: string[] | undefined
  /** Shown after the title. */
  description?: string | undefined
  /** Extra words the search matches. */
  keywords?: string | undefined
  icon: ReactNode
  run: () => void
}

export interface PaletteGroup {
  label: string
  items: PaletteItem[]
}

/** Groups for the current search text; return none when nothing applies. */
export type PaletteProvider = (query: string) => PaletteGroup[]

interface PaletteState {
  providers: Record<string, PaletteProvider>
  register: (key: string, provider: PaletteProvider) => void
  unregister: (key: string) => void
}

export const usePaletteProviders = create<PaletteState>((set) => ({
  providers: {},
  register: (key, provider) =>
    set((state) => ({ providers: { ...state.providers, [key]: provider } })),
  unregister: (key) =>
    set((state) => {
      const { [key]: _gone, ...providers } = state.providers
      return { providers }
    }),
}))

/** Case-insensitive match on the title and keywords; everything matches an empty query. */
export function matchesQuery(item: PaletteItem, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return (
    needle === '' ||
    item.title.toLowerCase().includes(needle) ||
    (item.keywords ?? '').toLowerCase().includes(needle)
  )
}
