// What a developer sets once on the Logs page and expects to find again:
// wrapped lines and lines kept across engine restarts. Per browser, in
// localStorage, followed across tabs; a browser that refuses storage keeps
// them for the tab. The clock format is the console-wide one in
// `lib/format.ts`, not this file's. A view of the log (its filter and
// window) is a link: the menu and ⌘K copy it, and a bookmark keeps it.

import { create } from 'zustand'

const WRAP_KEY = 'firenook.console.logs.wrap'
const KEEP_KEY = 'firenook.console.logs.keep-across-restarts'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage refused: the choice holds for this tab.
  }
}

interface LogsPrefs {
  wrap: boolean
  keepAcrossRestarts: boolean
  setWrap: (wrap: boolean) => void
  setKeepAcrossRestarts: (keep: boolean) => void
}

export const useLogsPrefs = create<LogsPrefs>((set) => ({
  wrap: read(WRAP_KEY) === 'true',
  keepAcrossRestarts: read(KEEP_KEY) === 'true',
  setWrap: (wrap) => {
    write(WRAP_KEY, wrap ? 'true' : null)
    set({ wrap })
  },
  setKeepAcrossRestarts: (keep) => {
    write(KEEP_KEY, keep ? 'true' : null)
    set({ keepAcrossRestarts: keep })
  },
}))

// Another tab changing a preference changes it here too.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === WRAP_KEY) useLogsPrefs.setState({ wrap: event.newValue === 'true' })
    else if (event.key === KEEP_KEY)
      useLogsPrefs.setState({ keepAcrossRestarts: event.newValue === 'true' })
  })
