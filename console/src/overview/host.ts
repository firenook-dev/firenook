// The host the Overview's connection snippets use, chosen per browser: the
// engine's connect host, the address this page was opened at when that
// differs, the Android emulator's `10.0.2.2` (all offered by
// `lib/connect.ts`), or a host the developer types ("Custom…"). The choice
// is kept in localStorage; until there is one, or when the one kept is no
// longer offered (the page was opened another way), the default follows
// the console's one rule for addresses (`defaultConnectHost`). A browser
// that refuses storage keeps the choice for this tab.

import { create } from 'zustand'
import type { ConsoleStatus } from '@/api/generated/ConsoleStatus'
import { connectHosts, defaultConnectHost } from '@/lib/connect'

export const HOST_KEY = 'firenook.console.connect-host'

/** A host the developer picked: one of those offered, or one typed. */
export interface HostChoice {
  host: string
  custom: boolean
}

/** The choice kept in `storage`; `undefined` when there is none or it cannot be read. */
export function readHostChoice(
  storage: Pick<Storage, 'getItem'> | undefined,
): HostChoice | undefined {
  try {
    const raw = storage?.getItem(HOST_KEY)
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { host, custom } = parsed as Record<string, unknown>
    if (typeof host !== 'string' || host.trim() === '' || typeof custom !== 'boolean')
      return undefined
    return { host: host.trim(), custom }
  } catch {
    // Unreadable storage or a malformed value: no choice yet.
    return undefined
  }
}

export function writeHostChoice(
  storage: Pick<Storage, 'setItem'> | undefined,
  choice: HostChoice,
): void {
  try {
    storage?.setItem(HOST_KEY, JSON.stringify(choice))
  } catch {
    // Refused storage: the choice lasts for this tab.
  }
}

/**
 * The host to use: a typed one as kept, an offered one while it is still
 * offered, else the default.
 */
export function resolveHost(
  choice: HostChoice | undefined,
  offered: readonly { host: string }[],
  fallback: string,
): HostChoice {
  if (choice?.custom) return choice
  if (choice && offered.some((option) => option.host === choice.host)) return choice
  return { host: fallback, custom: false }
}

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

const useHostChoice = create<{
  choice: HostChoice | undefined
  set: (choice: HostChoice) => void
}>((set) => ({
  choice: readHostChoice(browserStorage()),
  set: (choice) => {
    writeHostChoice(browserStorage(), choice)
    set({ choice })
  },
}))

/**
 * The snippets' host for this engine and page, what to offer, and how to
 * change it: `choose(host)` for an offered one, `chooseCustom(host)` for a
 * typed one (blank keeps the current choice).
 */
export function useConnectHost(status: ConsoleStatus): {
  host: string
  custom: boolean
  options: readonly { host: string; label: string }[]
  choose: (host: string) => void
  chooseCustom: (host: string) => void
} {
  const choice = useHostChoice((state) => state.choice)
  const set = useHostChoice((state) => state.set)
  const options = connectHosts(status)
  const resolved = resolveHost(choice, options, defaultConnectHost(status).host)
  return {
    ...resolved,
    options,
    choose: (host) => set({ host, custom: false }),
    chooseCustom: (host) => {
      const typed = host.trim().replace(/^\[|\]$/g, '')
      if (typed) set({ host: typed, custom: true })
    },
  }
}
