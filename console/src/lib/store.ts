import { create } from 'zustand'

// Ephemeral UI state that is neither server data nor part of the URL.
interface ConsoleUiState {
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  togglePalette: () => void
}

export const useConsoleUi = create<ConsoleUiState>((set) => ({
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
}))
