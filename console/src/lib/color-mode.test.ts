import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'firenook.console.theme'

/** A controllable `prefers-color-scheme: dark`. */
function system(dark: boolean) {
  const listeners: ((event: { matches: boolean }) => void)[] = []
  const query = {
    matches: dark,
    addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
      listeners.push(listener),
    removeEventListener: () => {},
  }
  vi.stubGlobal('matchMedia', () => query)
  return {
    /** The OS changes; every listener hears about it. */
    change(nowDark: boolean) {
      query.matches = nowDark
      for (const listener of listeners) listener({ matches: nowDark })
    },
  }
}

/** The module keeps its store in module scope, so each test gets a fresh one. */
async function load() {
  vi.resetModules()
  return import('./color-mode')
}

const painted = () => document.documentElement.getAttribute('data-mode')

describe('the console theme', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('data-mode')
  })

  it('follows the operating system until told otherwise', async () => {
    system(true)
    const { startTheme, useTheme } = await load()
    startTheme()
    expect(useTheme.getState().choice).toBe('system')
    expect(useTheme.getState().mode).toBe('dark')
    expect(painted()).toBe('dark')
  })

  it('keeps following the system while that is the choice', async () => {
    const os = system(false)
    const { startTheme, useTheme } = await load()
    startTheme()
    expect(painted()).toBe('light')
    os.change(true)
    expect(useTheme.getState().mode).toBe('dark')
    expect(painted()).toBe('dark')
  })

  it('an explicit choice wins over the system, and outlives it changing', async () => {
    const os = system(true)
    const { startTheme, useTheme } = await load()
    startTheme()
    useTheme.getState().setChoice('light')
    expect(painted()).toBe('light')
    os.change(false)
    expect(painted()).toBe('light')
    os.change(true)
    expect(painted()).toBe('light')
    expect(useTheme.getState().choice).toBe('light')
  })

  it('remembers the choice for the next visit', async () => {
    system(true)
    const first = await load()
    first.startTheme()
    first.useTheme.getState().setChoice('light')
    expect(localStorage.getItem(KEY)).toBe('light')

    // A reload: the module starts over and the OS still says dark.
    const second = await load()
    second.startTheme()
    expect(second.useTheme.getState().choice).toBe('light')
    expect(painted()).toBe('light')
  })

  it('going back to the system picks the system up again', async () => {
    system(true)
    const { startTheme, useTheme } = await load()
    startTheme()
    useTheme.getState().setChoice('light')
    useTheme.getState().setChoice('system')
    expect(useTheme.getState().mode).toBe('dark')
    expect(painted()).toBe('dark')
  })

  it('starts from the system when storage holds nonsense or refuses to answer', async () => {
    localStorage.setItem(KEY, 'puce')
    system(true)
    const { useTheme } = await load()
    expect(useTheme.getState().choice).toBe('system')

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked')
    })
    const blocked = await load()
    expect(blocked.useTheme.getState().choice).toBe('system')
    vi.restoreAllMocks()
  })

  it('resolves and describes each choice', async () => {
    system(true)
    const { describeTheme, resolveTheme } = await load()
    expect(resolveTheme('system')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
    expect(describeTheme('system', 'dark')).toBe('match the system · dark right now')
    expect(describeTheme('light', 'light')).toBe('light')
  })
})
