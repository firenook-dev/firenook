// What the Overview adds to ⌘K while it is on screen: open "Connect your
// app" on any platform, and copy a platform's snippet straight to the
// clipboard. The suite-wide actions (saving a snapshot on the engine's
// machine, the engine's details) are the palette's own Suite group, offered
// on every page, so they are not repeated here.

import { CopyIcon, PlugsConnectedIcon } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { copyToClipboard } from '@/lib/copy'
import {
  type PaletteGroup,
  type PaletteItem,
  matchesQuery,
  usePaletteProviders,
} from '@/lib/palette'
import { CONNECT_TABS, type ConnectParam } from '@/lib/connect-tabs'

export const OVERVIEW_PALETTE = 'overview'

/** A row for one platform (connect with it, copy its snippet): offered once something is typed. */
function perPlatform(item: PaletteItem): boolean {
  return item.id.startsWith('overview:copy:') || item.id.startsWith('overview:connect:')
}

export function useOverviewPalette({
  connect,
  snippet,
}: {
  /** Brings "Connect your app" into view, on a platform's tab when one is named. */
  connect: (param: ConnectParam | undefined) => void
  /** The snippet a platform's tab shows now (host and ports included). */
  snippet: (param: ConnectParam) => string
}) {
  const register = usePaletteProviders((state) => state.register)
  const unregister = usePaletteProviders((state) => state.unregister)
  useEffect(() => {
    const items: PaletteItem[] = [
      {
        id: 'overview:connect',
        title: 'Connect your app',
        description: 'The code that points an app at this engine, for every platform',
        keywords: 'connect snippet emulator sdk setup',
        icon: <PlugsConnectedIcon size={16} />,
        run: () => connect(undefined),
      },
      ...CONNECT_TABS.map<PaletteItem>((tab) => ({
        id: `overview:connect:${tab.param}`,
        title: `Connect with ${tab.label}`,
        description: tab.title,
        keywords: `connect snippet emulator sdk setup ${tab.param}`,
        icon: <PlugsConnectedIcon size={16} />,
        run: () => connect(tab.param),
      })),
      ...CONNECT_TABS.map<PaletteItem>((tab) => ({
        id: `overview:copy:${tab.param}`,
        title: `Copy the ${tab.label} snippet`,
        description: 'With this engine’s host, ports and project id',
        keywords: `copy clipboard connect snippet ${tab.param}`,
        icon: <CopyIcon size={16} />,
        run: () => {
          void copyToClipboard(snippet(tab.param), {
            what: `the ${tab.label} snippet`,
            refused: 'Copy it from the Connect panel on the Overview instead.',
          })
        },
      })),
    ]
    const provider = (query: string): PaletteGroup[] => {
      // Each platform is offered once something is typed; the empty palette
      // has the one way in.
      const typed = query.trim() !== ''
      const shown = items.filter(
        (item) =>
          matchesQuery(item, query) &&
          (typed ? item.id !== 'overview:connect' : !perPlatform(item)),
      )
      return shown.length > 0 ? [{ label: 'Overview', items: shown }] : []
    }
    register(OVERVIEW_PALETTE, provider)
    return () => unregister(OVERVIEW_PALETTE)
  }, [register, unregister, connect, snippet])
}
